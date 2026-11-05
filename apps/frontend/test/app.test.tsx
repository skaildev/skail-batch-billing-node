import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchResult, doneCount, type BatchView, type InvoiceView } from "@skail-batch-billing/contracts";
import { App } from "../src/App";

const row = (number: number, patch: Partial<InvoiceView> = {}): InvoiceView => ({
  number,
  customer: `Customer ${String(number).padStart(3, "0")}`,
  amount: 100 + number,
  state: "Issuing",
  attempts: 1,
  reason: null,
  invoiceNumber: null,
  ...patch,
});

const view = (patch: Partial<BatchView> = {}): BatchView => {
  const invoices = patch.invoices ?? Array.from({ length: 10 }, (_, i) => row(i + 1));
  const batch = {
    batchId: "batch-1",
    size: invoices.length,
    phase: "Starting" as const,
    invoices,
    result: null,
    error: null,
    customerInbox: [],
    financeInbox: [],
    ...patch,
  };
  return { ...batch, done: doneCount(batch.invoices), active: batch.phase === "Starting" || batch.phase === "Issuing" };
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: BatchView) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: Array<{ url: string; method: string; body?: string }>;
let answers: Record<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = { "GET /api/config": () => json({ sizes: [10, 20, 50], defaultSize: 20, monitorUrl: null }) };
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const button = () => screen.getByRole("button", { name: /Start|Issuing…/ });
const select = () => screen.getByLabelText("Batch size");

describe("App", () => {
  it("starts idle: Start enabled and the size dropdown with 10, 20 (default) and 50", () => {
    render(<App />);
    expect(button()).toHaveTextContent("Start");
    expect(button()).toBeEnabled();
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(select()).toHaveValue("20");
    expect(
      within(select())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["10 invoices", "20 invoices", "50 invoices"]);
  });

  it("shows the empty invoices table and both inboxes (with zero counters) before any batch", () => {
    render(<App />);
    expect(screen.getByRole("table", { name: "Invoices" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Customer inbox" })).getByLabelText("count")).toHaveTextContent(
      "0",
    );
    expect(within(screen.getByRole("region", { name: "Finance inbox" })).getByLabelText("count")).toHaveTextContent(
      "0",
    );
    expect(screen.getByText("(PDFs received)")).toBeInTheDocument();
    expect(screen.getByText("(tickets received)")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("click sends the chosen size; button and dropdown get disabled, the batch id is remembered and the stream opens", async () => {
    answers["POST /api/batches"] = () => json(view());
    render(<App />);
    await userEvent.selectOptions(select(), "10");
    await userEvent.click(button());

    await waitFor(() => expect(button()).toHaveTextContent("Issuing…"));
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ size: 10 });
    expect(button()).toBeDisabled();
    expect(select()).toBeDisabled();
    expect(screen.getByText("batch-1")).toBeInTheDocument();
    expect(localStorage.getItem("batch-billing.batchId")).toBe("batch-1");
    expect(FakeEventSource.instances[0]!.url).toBe("/api/batches/batch-1/stream");
  });

  it("shows the trigger error and keeps Start available", async () => {
    answers["POST /api/batches"] = () => json({ error: "sidecar down" }, 502);
    render(<App />);
    await userEvent.click(button());

    expect(await screen.findByText(/sidecar down/)).toBeInTheDocument();
    expect(button()).toBeEnabled();
  });

  it("shows the counter, the status and one grid row per invoice with its state, attempts and reason", async () => {
    answers["POST /api/batches"] = () => json(view());
    render(<App />);
    await userEvent.click(button());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0]!.emit(
      view({
        phase: "Issuing",
        invoices: [
          row(1, { state: "Authorized", invoiceNumber: "NF-000001" }),
          row(2, { attempts: 3, reason: "city hall unavailable" }),
          row(5, { state: "Rejected", reason: "invalid customer tax id (CNPJ)" }),
          row(7, { state: "Pending", reason: "waiting for the city hall to process it" }),
        ],
      }),
    );

    expect(screen.getByText("Issuing in parallel", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByText("3/4")).toBeInTheDocument();
    const grid = screen.getByRole("table", { name: "Invoices" });
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Authorized")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("NF-000001")).toBeInTheDocument(); // the note column shows the invoice number
    expect(within(rows[1]!).getByText("Issuing…")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("3")).toBeInTheDocument();
    expect(rows[1]).toHaveClass("retried"); // retried invoices stand out
    expect(rows[0]).not.toHaveClass("retried");
    expect(within(rows[2]!).getByText("Rejected")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("invalid customer tax id (CNPJ)")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Pending")).toBeInTheDocument();
  });

  it("fills the two inboxes with their counters, each invoice in its own box", async () => {
    answers["POST /api/batches"] = () => json(view());
    render(<App />);
    await userEvent.click(button());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0]!.emit(
      view({
        phase: "Issuing",
        customerInbox: [
          {
            number: 1,
            customer: "Customer 001",
            amount: 101,
            invoiceNumber: "NF-000001",
            protocol: "P",
            fileName: "NF-000001.pdf",
          },
        ],
        financeInbox: [
          {
            number: 5,
            customer: "Customer 005",
            amount: 105,
            status: "Rejected",
            reason: "invalid customer tax id (CNPJ)",
          },
          { number: 7, customer: "Customer 007", amount: 107, status: "Pending", reason: "aguardando" },
        ],
      }),
    );

    const customer = screen.getByRole("region", { name: "Customer inbox" });
    const finance = screen.getByRole("region", { name: "Finance inbox" });
    expect(within(customer).getByLabelText("count")).toHaveTextContent("1");
    expect(within(customer).getByText("NF-000001.pdf")).toBeInTheDocument();
    expect(within(finance).getByLabelText("count")).toHaveTextContent("2");
    expect(within(finance).getByText("Rejected")).toBeInTheDocument();
    expect(within(finance).getByText("Pending")).toBeInTheDocument();
    expect(within(customer).queryByText("Customer 005")).not.toBeInTheDocument();
  });

  it("Completed shows the summary, closes the stream and re-enables Start and the dropdown", async () => {
    answers["POST /api/batches"] = () => json(view());
    render(<App />);
    await userEvent.click(button());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const invoice = (n: number) => ({ ...row(n), state: "Authorized" as const });
    FakeEventSource.instances[0]!.emit(
      view({
        phase: "Completed",
        invoices: [invoice(1), invoice(2)],
        result: BatchResult.consolidate("batch-1", [
          {
            number: 1,
            customer: "a",
            amount: 100,
            status: "Authorized",
            invoiceNumber: "x",
            protocol: null,
            reason: null,
          },
          {
            number: 2,
            customer: "b",
            amount: 50,
            status: "Rejected",
            invoiceNumber: null,
            protocol: null,
            reason: null,
          },
        ]),
      }),
    );

    expect(screen.getByText("Completed")).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText(/authorized \(PDF sent\)/).parentElement).toHaveTextContent("1");
    expect(within(summary).getByText(/rejected \(finance\)/).parentElement).toHaveTextContent("1");
    expect(within(summary).getByText(/billed/).parentElement).toHaveTextContent("100");
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(button()).toHaveTextContent("Start");
    expect(button()).toBeEnabled();
    expect(select()).toBeEnabled();
    expect(localStorage.getItem("batch-billing.batchId")).toBeNull();
  });

  it("Failed shows the error", async () => {
    answers["POST /api/batches"] = () => json(view());
    render(<App />);
    await userEvent.click(button());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0]!.emit(view({ phase: "Failed", error: "boom" }));
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(button()).toBeEnabled();
  });

  it("reload restores the active batch from the server (button and dropdown stay locked, size restored)", async () => {
    localStorage.setItem("batch-billing.batchId", "batch-1");
    answers["GET /api/batches/batch-1"] = () => json(view({ phase: "Issuing" }));
    render(<App />);

    await waitFor(() => expect(button()).toHaveTextContent("Issuing…"));
    expect(select()).toBeDisabled();
    expect(select()).toHaveValue("10");
    expect(FakeEventSource.instances[0]!.url).toBe("/api/batches/batch-1/stream");
  });

  it("forgets a saved batch the server no longer knows", async () => {
    localStorage.setItem("batch-billing.batchId", "gone");
    answers["GET /api/batches/gone"] = () => json({}, 404);
    render(<App />);

    await waitFor(() => expect(localStorage.getItem("batch-billing.batchId")).toBeNull());
    expect(button()).toBeEnabled();
  });

  it("shows a link to the skail Monitor when MONITOR_URL is configured", async () => {
    answers["GET /api/config"] = () =>
      json({ sizes: [10, 20, 50], defaultSize: 20, monitorUrl: "https://monitor.example.test" });
    render(<App />);
    const link = await screen.findByRole("link", { name: /Monitor/ });
    expect(link).toHaveAttribute("href", "https://monitor.example.test");
  });
});
