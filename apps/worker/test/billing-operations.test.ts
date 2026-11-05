import { describe, expect, it } from "vitest";
import { BatchEvent, Orders, type BatchEvent as Evt, type Invoice } from "@skail-batch-billing/contracts";
import { BillingOperations } from "../src/billing-operations.js";
import { FakeCityHall, decide } from "../src/city-hall.js";
import type { ProgressNotifier } from "../src/web.js";

class RecordingNotifier implements ProgressNotifier {
  events: Evt[] = [];
  fail = false;
  async notify(event: Evt) {
    if (this.fail) throw new Error("web down");
    this.events.push(event);
  }
}

const order = (n: number) => Orders.generate("b", n).at(-1)!;
const setup = (failFirst = 0) => {
  const notifier = new RecordingNotifier();
  return { notifier, ops: new BillingOperations(new FakeCityHall(failFirst), notifier) };
};

describe("BillingOperations.issue", () => {
  it("returns the invoice", async () => {
    const { ops } = setup();
    expect(await ops.issue("b", 5, order(3))).toMatchObject({ number: 3, status: "Authorized" });
  });

  it("returns a rejection as a result", async () => {
    const { ops } = setup();
    expect((await ops.issue("b", 5, order(5))).status).toBe("Rejected");
  });

  it("propagates the technical failure (so skail retries) and reports the retry to the page", async () => {
    const { ops, notifier } = setup(1);
    await expect(ops.issue("b", 5, order(3))).rejects.toThrow("city hall unavailable");
    expect(notifier.events).toEqual([BatchEvent.retrying("b", 5, 3, "city hall unavailable")]);
  });

  it("still throws the outage when the retry hint cannot be delivered", async () => {
    const { ops, notifier } = setup(1);
    notifier.fail = true;
    await expect(ops.issue("b", 5, order(3))).rejects.toThrow("city hall unavailable");
  });
});

describe("delivery", () => {
  const authorized = decide(order(3));
  const rejected = decide(order(5));

  it("sends the PDF of an authorized invoice to the customer inbox", async () => {
    const { ops, notifier } = setup();
    await ops.sendPdf("b", 5, authorized);
    expect(notifier.events).toEqual([BatchEvent.pdfSent("b", 5, authorized)]);
  });

  it("refuses to send a PDF for an invoice that is not authorized", async () => {
    const { ops, notifier } = setup();
    await expect(ops.sendPdf("b", 5, rejected)).rejects.toThrow(/is not authorized/);
    expect(notifier.events).toEqual([]);
  });

  it("warns finance about a rejected or pending invoice", async () => {
    const { ops, notifier } = setup();
    const pending: Invoice = decide(order(7));
    await ops.notifyFinance("b", 5, rejected);
    await ops.notifyFinance("b", 5, pending);
    expect(notifier.events.map((e) => [e.stage, e.number])).toEqual([
      ["FinanceNotified", 5],
      ["FinanceNotified", 7],
    ]);
  });

  it("refuses to warn finance about an authorized invoice", async () => {
    const { ops } = setup();
    await expect(ops.notifyFinance("b", 5, authorized)).rejects.toThrow(/is authorized: finance/);
  });

  it("throws when the delivery fails (skail retries the command)", async () => {
    const { ops, notifier } = setup();
    notifier.fail = true;
    await expect(ops.sendPdf("b", 5, authorized)).rejects.toThrow("web down");
    await expect(ops.notifyFinance("b", 5, rejected)).rejects.toThrow("web down");
  });

  it("reportStatus forwards the event", async () => {
    const { ops, notifier } = setup();
    await ops.reportStatus(BatchEvent.started("b", 5));
    expect(notifier.events).toEqual([BatchEvent.started("b", 5)]);
  });
});
