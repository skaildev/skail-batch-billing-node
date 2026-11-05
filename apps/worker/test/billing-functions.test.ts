import { beforeEach, describe, expect, it } from "vitest";
import { EventType, fromRuntimeValue, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import {
  BatchLimits,
  isAuthorized,
  type BatchEvent,
  type BatchResult,
  type Invoice,
  type Order,
} from "@skail-batch-billing/contracts";
import { BillingFunctions } from "../src/billing-functions.js";
import { BillingOperations } from "../src/billing-operations.js";
import { FakeCityHall, CityHallUnavailableError, decide, type CityHall } from "../src/city-hall.js";
import type { ProgressNotifier } from "../src/web.js";

const WORKLOAD = "batch-billing:v0.0.1";
const BATCH = "batch-1";

/**
 * Drives the fan-out the way skail does: the batch is one run, and every IssueInvoice call is a child run (an Rpc
 * frame of the parent) that runs on its own and completes the parent's frame.
 */
class Harness {
  readonly events: BatchEvent[] = [];
  cityHall: CityHall = new FakeCityHall();
  readonly parent = new InMemorySkailPlatform();
  readonly children = new InMemorySkailPlatform();
  readonly parentWorker: SkailWorker;
  readonly childWorker: SkailWorker;

  constructor() {
    const notifier: ProgressNotifier = { notify: async (event) => void this.events.push(event) };
    const providers: Provider[] = [
      {
        token: BillingFunctions,
        useFactory: () => new BillingFunctions(new BillingOperations(this.cityHall, notifier)),
      },
    ];
    const common = { workload: WORKLOAD, types: [BillingFunctions], providers };
    this.parentWorker = createSkailWorker({ ...common, sidecar: this.parent });
    this.childWorker = createSkailWorker({ ...common, sidecar: this.children });
  }

  start(size: number) {
    this.parent.start(`${WORKLOAD}/BillBatch`, [BATCH, size], BATCH);
  }

  runParent() {
    return this.parent.consume().then((activation) => this.parentWorker.runActivation(activation!));
  }

  pendingChildren() {
    return this.parent.history(BATCH).filter((f) => f.eventType === EventType.Rpc && !f.targetResult);
  }

  /** Runs one child to the end (re-delivering it while its commands are retried) and completes the parent frame. */
  async runChild(frame: ReturnType<Harness["pendingChildren"]>[number]) {
    const args = frame.targetArguments.map((a) => fromRuntimeValue(a));
    this.children.start(frame.targetUri, args, frame.targetTaskId);
    for (let i = 0; i < 20; i++) {
      const activation = await this.children.consume();
      if (!activation) break;
      const outcome = await this.childWorker.runActivation(activation);
      if (outcome.status === "completed") {
        this.parent.complete(BATCH, frame.index, outcome.result);
        return outcome.result as Invoice;
      }
      this.children.enqueue(frame.targetTaskId); // hibernated after a failed command: skail re-delivers
    }
    throw new Error("child did not complete");
  }

  /** Whole batch: for each wave the parent fans out, the children run, and the parent resumes. */
  async runToEnd(size: number) {
    this.start(size);
    let outcome = await this.runParent();
    while (outcome.status === "hibernated" && this.pendingChildren().length > 0) {
      for (const frame of this.pendingChildren()) await this.runChild(frame);
      outcome = await this.runParent();
    }
    return outcome;
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

const events = (stage: BatchEvent["stage"]) => h.events.filter((e) => e.stage === stage);

describe("BillBatch", () => {
  it("reports Started, creates one child run per invoice of the first wave and hibernates until they finish", async () => {
    h.start(20);
    expect((await h.runParent()).status).toBe("hibernated");

    expect(events("Started")).toHaveLength(1);
    const children = h.pendingChildren();
    expect(children).toHaveLength(BatchLimits.waveSize); // 10: the second wave starts when the first ends
    expect(new Set(children.map((c) => c.targetTaskId)).size).toBe(10); // each invoice is a run of its own
    expect(children.every((c) => c.targetUri === `${WORKLOAD}/IssueInvoice`)).toBe(true);
    expect(events("InvoiceDone")).toHaveLength(0); // children have not run yet
  });

  it("runs a batch of 50 in 5 waves of 10", async () => {
    h.start(50);
    let waves = 0;
    let outcome = await h.runParent();
    while (outcome.status === "hibernated" && h.pendingChildren().length > 0) {
      waves++;
      expect(h.pendingChildren()).toHaveLength(10);
      for (const frame of h.pendingChildren()) await h.runChild(frame);
      outcome = await h.runParent();
    }

    expect(waves).toBe(5);
    expect(outcome).toMatchObject({ status: "completed", result: { total: 50 } });
    expect(events("InvoiceDone").map((e) => e.number)).toHaveLength(50);
  });

  it("consolidates a batch of 20: authorized, rejected (x5) and pending (x7), billing only the authorized", async () => {
    const outcome = await h.runToEnd(20);

    expect(outcome.status).toBe("completed");
    const result = (outcome as { result: BatchResult }).result;
    expect(result).toMatchObject({ batchId: BATCH, total: 20, authorized: 14, rejected: 4, pending: 2 });
    expect(result.amountBilled).toBeGreaterThan(0);
    expect(events("Completed")).toHaveLength(1);
    expect(events("Failed")).toHaveLength(0);
  });

  it("delivers the PDF only for authorized invoices and a finance ticket only for the others, once each", async () => {
    await h.runToEnd(20);

    const pdf = events("PdfSent")
      .map((e) => e.number)
      .sort((a, b) => a! - b!);
    const finance = events("FinanceNotified")
      .map((e) => e.number)
      .sort((a, b) => a! - b!);
    expect(pdf).toEqual([1, 2, 3, 4, 6, 8, 9, 11, 12, 13, 16, 17, 18, 19]);
    expect(finance).toEqual([5, 7, 10, 14, 15, 20]);
    expect(events("InvoiceDone")).toHaveLength(20);
  });

  it("retries only the invoice whose city hall call failed", async () => {
    const flaky = new Map<number, number>(); // number -> failures left
    flaky.set(3, 2);
    const calls: number[] = [];
    h.cityHall = {
      issue: async (order: Order) => {
        calls.push(order.number);
        const left = flaky.get(order.number) ?? 0;
        if (left > 0) {
          flaky.set(order.number, left - 1);
          throw new CityHallUnavailableError();
        }
        return decide(order);
      },
    };

    const outcome = await h.runToEnd(10);

    expect(outcome.status).toBe("completed");
    expect(calls.filter((n) => n === 3)).toHaveLength(3); // two failures + the success
    expect(calls.filter((n) => n !== 3)).toHaveLength(9); // everyone else called once
    expect(events("Retrying").map((e) => e.number)).toEqual([3, 3]);
  });

  it("turns an invoice that exhausts every attempt into a pending invoice and still completes the batch", async () => {
    h.cityHall = {
      issue: async (order: Order): Promise<Invoice> => {
        if (order.number === 3) throw new CityHallUnavailableError();
        return decide(order);
      },
    };

    const outcome = await h.runToEnd(10);

    expect(outcome.status).toBe("completed");
    const invoice3 = events("InvoiceDone").find((e) => e.number === 3)!.invoice!;
    expect(invoice3).toMatchObject({ status: "Pending", reason: "city hall unavailable" });
    expect(isAuthorized(invoice3)).toBe(false);
    expect(events("FinanceNotified").map((e) => e.number)).toContain(3);
    expect(events("Completed")).toHaveLength(1);
  });
});
