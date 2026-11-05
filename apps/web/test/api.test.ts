import { beforeEach, describe, expect, it } from "vitest";
import { BatchEvent, BatchResult, type Invoice } from "@skail-batch-billing/contracts";
import { createApp } from "../src/app.js";
import { SkailGatewayError, type SkailGateway } from "../src/gateway.js";
import { BatchStore } from "../src/batch-store.js";

class FakeGateway implements SkailGateway {
  triggers: Array<[string, number]> = [];
  failTrigger = false;
  async trigger(batchId: string, size: number) {
    if (this.failTrigger) throw new SkailGatewayError("sidecar down");
    this.triggers.push([batchId, size]);
  }
}

let store: BatchStore;
let gateway: FakeGateway;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new BatchStore();
  gateway = new FakeGateway();
  app = createApp({ store, gateway, monitorUrl: "https://monitor.example.test" });
});

const start = (payload?: unknown) => app.inject({ method: "POST", url: "/api/batches", payload: payload as object });
const notify = (id: string, event: BatchEvent) =>
  app.inject({ method: "POST", url: `/internal/batches/${id}/events`, payload: { ...event, batchId: "ignored" } });
const invoice = (number: number, status: Invoice["status"]): Invoice => ({
  number,
  customer: `Customer ${String(number).padStart(3, "0")}`,
  amount: 100,
  status,
  invoiceNumber: status === "Authorized" ? "NF-000001" : null,
  protocol: null,
  reason: null,
});

describe("web API", () => {
  it("answers /healthz", async () => {
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });

  it("/api/config returns the sizes, the default and the monitor link", async () => {
    expect((await app.inject({ url: "/api/config" })).json()).toEqual({
      sizes: [10, 20, 50],
      defaultSize: 20,
      monitorUrl: "https://monitor.example.test",
    });
  });

  it("POST /api/batches without a size uses 20 and returns the view (same JSON as .NET)", async () => {
    const res = await start();
    expect(res.statusCode).toBe(200);
    const view = res.json();

    expect(gateway.triggers).toEqual([[view.batchId, 20]]);
    expect(view).toMatchObject({
      size: 20,
      phase: "Starting",
      done: 0,
      active: true,
      result: null,
      error: null,
      customerInbox: [],
      financeInbox: [],
    });
    expect(view.invoices).toHaveLength(20);
  });

  it.each([10, 50])("accepts the size %i", async (size) => {
    const view = (await start({ size })).json();
    expect(view.size).toBe(size);
    expect(gateway.triggers[0]![1]).toBe(size);
  });

  it.each([5, 21, 100, "20", 0])("rejects the size %s with 400 and does not trigger", async (size) => {
    const res = await start({ size });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("10, 20, 50");
    expect(gateway.triggers).toEqual([]);
  });

  it("uses a new batchId on each click", async () => {
    const a = (await start()).json();
    const b = (await start()).json();
    expect(a.batchId).not.toBe(b.batchId);
  });

  it("answers 502 and forgets the batch when the trigger fails", async () => {
    gateway.failTrigger = true;
    const res = await start();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("sidecar down");
  });

  it("internal events use the id of the URL and move the view; Completed ends the batch", async () => {
    const { batchId } = (await start({ size: 10 })).json();
    expect((await notify(batchId, BatchEvent.started(batchId, 10))).statusCode).toBe(204);
    await notify(batchId, BatchEvent.invoiceDone(batchId, 10, invoice(1, "Authorized")));
    await notify(batchId, BatchEvent.pdfSent(batchId, 10, invoice(1, "Authorized")));
    await notify(batchId, BatchEvent.financeNotified(batchId, 10, invoice(5, "Rejected")));

    let view = (await app.inject({ url: `/api/batches/${batchId}` })).json();
    expect(view).toMatchObject({ phase: "Issuing", done: 1, active: true });
    expect(view.customerInbox).toHaveLength(1);
    expect(view.financeInbox).toHaveLength(1);

    await notify(batchId, BatchEvent.completed(batchId, BatchResult.consolidate(batchId, [invoice(1, "Authorized")])));
    view = (await app.inject({ url: `/api/batches/${batchId}` })).json();
    expect(view).toMatchObject({ phase: "Completed", active: false, result: { authorized: 1 } });
  });

  it("GET of an unknown batch is 404", async () => {
    expect((await app.inject({ url: "/api/batches/nope" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/batches/nope/stream" })).statusCode).toBe(404);
  });

  it("SSE sends the snapshot, then every change in order, and ends at the terminal phase", async () => {
    const { batchId } = (await start({ size: 10 })).json();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${port}/api/batches/${batchId}/stream`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const phases: string[] = [];
    let buffer = "";
    const read = async (until: number) => {
      while (phases.length < until) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value);
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;
        for (const part of parts) phases.push(JSON.parse(part.replace(/^data: /, "")).phase);
      }
    };

    await read(1);
    await notify(batchId, BatchEvent.started(batchId, 10));
    await read(2);
    await notify(batchId, BatchEvent.completed(batchId, BatchResult.consolidate(batchId, [])));
    await read(3);
    const end = await reader.read();

    expect(phases).toEqual(["Starting", "Issuing", "Completed"]);
    expect(end.done).toBe(true);
    await app.close();
  });
});
