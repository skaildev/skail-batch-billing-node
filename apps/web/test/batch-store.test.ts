import { beforeEach, describe, expect, it } from "vitest";
import { BatchEvent, BatchResult, type BatchState, type Invoice } from "@skail-batch-billing/contracts";
import { BatchStore } from "../src/batch-store.js";

const invoice = (number: number, status: Invoice["status"], reason: string | null = null): Invoice => ({
  number,
  customer: `Customer ${String(number).padStart(3, "0")}`,
  amount: 100 + number,
  status,
  invoiceNumber: status === "Authorized" ? `NF-${String(number).padStart(6, "0")}` : null,
  protocol: status === "Authorized" ? "PROT-1" : null,
  reason,
});

let store: BatchStore;
const state = (): BatchState => store.get("b")!;

beforeEach(() => {
  store = new BatchStore();
  store.create("b", 10);
});

describe("BatchStore", () => {
  it("creates the batch Starting with one Issuing row per order and empty inboxes", () => {
    expect(state()).toMatchObject({
      batchId: "b",
      size: 10,
      phase: "Starting",
      result: null,
      error: null,
      customerInbox: [],
      financeInbox: [],
    });
    expect(state().invoices).toHaveLength(10);
    expect(state().invoices[0]).toEqual({
      number: 1,
      customer: "Customer 001",
      amount: 137.13,
      state: "Issuing",
      attempts: 1,
      reason: null,
      invoiceNumber: null,
    });
  });

  it("Started moves to Issuing; a repeated Started is ignored", () => {
    expect(store.apply(BatchEvent.started("b", 10))).toBe(true);
    expect(state().phase).toBe("Issuing");
    expect(store.apply(BatchEvent.started("b", 10))).toBe(false);
  });

  it("Retrying counts the attempts of that invoice only and keeps the reason", () => {
    store.apply(BatchEvent.retrying("b", 10, 3, "city hall unavailable"));
    store.apply(BatchEvent.retrying("b", 10, 3, "city hall unavailable"));
    expect(state().invoices.find((n) => n.number === 3)).toMatchObject({
      attempts: 3,
      reason: "city hall unavailable",
      state: "Issuing",
    });
    expect(state().invoices.find((n) => n.number === 4)!.attempts).toBe(1);
  });

  it("InvoiceDone sets Authorized, Rejected or Pending with the reason and the invoice number", () => {
    store.apply(BatchEvent.invoiceDone("b", 10, invoice(1, "Authorized")));
    store.apply(BatchEvent.invoiceDone("b", 10, invoice(5, "Rejected", "invalid customer tax id (CNPJ)")));
    store.apply(BatchEvent.invoiceDone("b", 10, invoice(7, "Pending", "aguardando")));

    const rows = state().invoices;
    expect(rows[0]).toMatchObject({ state: "Authorized", invoiceNumber: "NF-000001" });
    expect(rows[4]).toMatchObject({ state: "Rejected", reason: "invalid customer tax id (CNPJ)" });
    expect(rows[6]).toMatchObject({ state: "Pending", reason: "aguardando" });
  });

  it("accepts an invoice finished before Started (children are other executions): the more advanced state wins", () => {
    store.apply(BatchEvent.invoiceDone("b", 10, invoice(1, "Authorized")));
    expect(state().phase).toBe("Issuing");
    expect(store.apply(BatchEvent.started("b", 10))).toBe(false);
  });

  it("ignores a duplicate InvoiceDone and a late Retrying for a finished invoice", () => {
    expect(store.apply(BatchEvent.invoiceDone("b", 10, invoice(1, "Authorized")))).toBe(true);
    expect(store.apply(BatchEvent.invoiceDone("b", 10, invoice(1, "Rejected")))).toBe(false);
    expect(store.apply(BatchEvent.retrying("b", 10, 1, "x"))).toBe(false);
    expect(state().invoices[0]!.state).toBe("Authorized");
  });

  it("customer inbox: only authorized invoices, once each, with the PDF file name", () => {
    store.apply(BatchEvent.pdfSent("b", 10, invoice(1, "Authorized")));
    store.apply(BatchEvent.pdfSent("b", 10, invoice(1, "Authorized")));
    store.apply(BatchEvent.pdfSent("b", 10, invoice(5, "Rejected")));

    expect(state().customerInbox).toEqual([
      {
        number: 1,
        customer: "Customer 001",
        amount: 101,
        invoiceNumber: "NF-000001",
        protocol: "PROT-1",
        fileName: "NF-000001.pdf",
      },
    ]);
  });

  it("finance inbox: only rejected or pending invoices, once each", () => {
    store.apply(BatchEvent.financeNotified("b", 10, invoice(5, "Rejected", "invalid customer tax id (CNPJ)")));
    store.apply(BatchEvent.financeNotified("b", 10, invoice(5, "Rejected", "invalid customer tax id (CNPJ)")));
    store.apply(BatchEvent.financeNotified("b", 10, invoice(7, "Pending", "aguardando")));
    store.apply(BatchEvent.financeNotified("b", 10, invoice(1, "Authorized")));

    expect(state().financeInbox).toEqual([
      {
        number: 5,
        customer: "Customer 005",
        amount: 105,
        status: "Rejected",
        reason: "invalid customer tax id (CNPJ)",
      },
      { number: 7, customer: "Customer 007", amount: 107, status: "Pending", reason: "aguardando" },
    ]);
  });

  it("Completed stores the result and is terminal: later events are ignored", () => {
    const result = BatchResult.consolidate("b", [invoice(1, "Authorized")]);
    store.apply(BatchEvent.completed("b", result));
    expect(state()).toMatchObject({ phase: "Completed", result });
    expect(store.apply(BatchEvent.failed("b", 10, "late"))).toBe(false);
    expect(state().phase).toBe("Completed");
  });

  it("Failed carries the error (or a default)", () => {
    store.apply(BatchEvent.failed("b", 10, "boom"));
    expect(state()).toMatchObject({ phase: "Failed", error: "boom" });
  });

  it("ignores events of an unknown batch", () => {
    expect(store.apply(BatchEvent.started("nope", 1))).toBe(false);
  });

  it("notifies subscribers on every change and closes them at the terminal phase", () => {
    const phases: string[] = [];
    let closed = false;
    store.subscribe(
      "b",
      (s) => phases.push(s.phase),
      () => (closed = true),
    );

    store.apply(BatchEvent.started("b", 10));
    store.apply(BatchEvent.completed("b", BatchResult.consolidate("b", [])));

    expect(phases).toEqual(["Issuing", "Completed"]);
    expect(closed).toBe(true);
  });

  it("stops notifying after unsubscribe and closes subscribers when the batch is removed", () => {
    const phases: string[] = [];
    const off = store.subscribe(
      "b",
      (s) => phases.push(s.phase),
      () => {},
    );
    off();
    store.apply(BatchEvent.started("b", 10));
    expect(phases).toEqual([]);

    let closed = false;
    store.subscribe(
      "b",
      () => {},
      () => (closed = true),
    );
    store.remove("b");
    expect(closed).toBe(true);
    expect(store.get("b")).toBeUndefined();
  });
});
