import { describe, expect, it } from "vitest";
import {
  BatchEvent,
  BatchLimits,
  BatchResult,
  Invoice,
  Orders,
  isAuthorized,
  chunk,
  doneCount,
  isTerminalPhase,
  startState,
  type InvoiceView,
} from "../src/index.js";

const invoice = (number: number, status: Invoice["status"], amount = 100): Invoice => ({
  number,
  customer: `Customer ${number}`,
  amount,
  status,
  invoiceNumber: status === "Authorized" ? `NF-${number}` : null,
  protocol: null,
  reason: null,
});

describe("BatchLimits", () => {
  it("offers 10, 20 (default) and 50", () => {
    expect(BatchLimits.sizes).toEqual([10, 20, 50]);
    expect(BatchLimits.defaultSize).toBe(20);
    expect(BatchLimits.maxSize).toBe(50);
  });
});

describe("Orders.generate", () => {
  it("is deterministic: numbered 1..N, ids derived from the batch id", () => {
    const a = Orders.generate("b1", 20);
    expect(a).toEqual(Orders.generate("b1", 20));
    expect(a.map((p) => p.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(a[0]).toEqual({ id: "b1-1", number: 1, customer: "Customer 001", amount: 137.13 });
    expect(new Set(a.map((p) => p.id)).size).toBe(20);
  });
});

describe("Invoice", () => {
  it("is authorized only with status Authorized", () => {
    expect(isAuthorized(invoice(1, "Authorized"))).toBe(true);
    expect(isAuthorized(invoice(2, "Rejected"))).toBe(false);
    expect(isAuthorized(invoice(3, "Pending"))).toBe(false);
  });

  it("pending keeps the order data and carries the reason", () => {
    const [order] = Orders.generate("b", 1);
    expect(Invoice.pending(order!, "city hall unavailable")).toEqual({
      number: 1,
      customer: "Customer 001",
      amount: order!.amount,
      status: "Pending",
      invoiceNumber: null,
      protocol: null,
      reason: "city hall unavailable",
    });
  });
});

describe("BatchResult.consolidate", () => {
  it("counts by status and bills only the authorized ones (rounded to cents)", () => {
    const result = BatchResult.consolidate("b", [
      invoice(1, "Authorized", 100.1),
      invoice(2, "Authorized", 200.2),
      invoice(3, "Rejected", 999),
      invoice(4, "Pending", 888),
    ]);
    expect(result).toEqual({ batchId: "b", total: 4, authorized: 2, rejected: 1, pending: 1, amountBilled: 300.3 });
  });
});

describe("BatchEvent", () => {
  it("builds the events with the same shape as the .NET demo", () => {
    const n = invoice(7, "Rejected");
    expect(BatchEvent.started("b", 20)).toMatchObject({ batchId: "b", stage: "Started", total: 20 });
    expect(BatchEvent.retrying("b", 20, 3, "down")).toMatchObject({ stage: "Retrying", number: 3, error: "down" });
    expect(BatchEvent.invoiceDone("b", 20, n)).toMatchObject({ stage: "InvoiceDone", number: 7, invoice: n });
    expect(BatchEvent.pdfSent("b", 20, n)).toMatchObject({ stage: "PdfSent", invoice: n });
    expect(BatchEvent.financeNotified("b", 20, n)).toMatchObject({ stage: "FinanceNotified", invoice: n });
    const result = BatchResult.consolidate("b", [n]);
    expect(BatchEvent.completed("b", result)).toMatchObject({ stage: "Completed", total: 1, result });
    expect(BatchEvent.failed("b", 20, "boom")).toMatchObject({ stage: "Failed", error: "boom" });
  });
});

describe("start button rules", () => {
  it("is enabled when there is no batch or it is finished, disabled while active", () => {
    expect(startState(undefined)).toEqual({ label: "Start", enabled: true });
    expect(startState({ phase: "Completed" })).toEqual({ label: "Start", enabled: true });
    expect(startState({ phase: "Failed" })).toEqual({ label: "Start", enabled: true });
    expect(startState({ phase: "Starting" })).toEqual({ label: "Issuing…", enabled: false });
    expect(startState({ phase: "Issuing" })).toEqual({ label: "Issuing…", enabled: false });
  });

  it("knows terminal phases and counts finished invoices", () => {
    expect(isTerminalPhase("Completed")).toBe(true);
    expect(isTerminalPhase("Issuing")).toBe(false);
    const view = (state: InvoiceView["state"]): InvoiceView => ({
      number: 1,
      customer: "",
      amount: 1,
      state,
      attempts: 1,
      reason: null,
      invoiceNumber: null,
    });
    expect(doneCount([view("Issuing"), view("Authorized"), view("Rejected")])).toBe(2);
  });
});

describe("chunk", () => {
  it("splits into waves keeping the order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
    expect(chunk(Orders.generate("b", 50), BatchLimits.waveSize).map((w) => w.length)).toEqual([10, 10, 10, 10, 10]);
    expect(chunk(Orders.generate("b", 20), BatchLimits.waveSize)).toHaveLength(2);
  });
});
