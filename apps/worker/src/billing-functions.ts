import { Skail, SkailCommand, SkailFunction, SkailNonDeterministicError } from "@skail/runtime";
import {
  BatchEvent,
  BatchLimits,
  BatchResult,
  Invoice,
  Orders,
  chunk,
  isAuthorized,
  type Order,
} from "@skail-batch-billing/contracts";
import type { BillingOperations } from "./billing-operations.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The method names are PascalCase on purpose: the skail route is <workload>/<method>, and the web app triggers
// <workload>/BillBatch.
export class BillingFunctions {
  constructor(private readonly operations: BillingOperations) {}

  /**
   * Issues the invoices of the batch in waves of 10: one child execution per invoice, and the next wave starts when
   * the current one ends, so the city hall never gets more than 10 requests at once. When every invoice is done, it
   * consolidates the result.
   */
  @SkailFunction()
  async BillBatch(batchId: string, size: number): Promise<BatchResult> {
    try {
      const orders = Orders.generate(batchId, size); // only arithmetic over the arguments, so it is deterministic
      await this.ReportStatus(BatchEvent.started(batchId, size));

      const invoices: Invoice[] = [];
      for (const wave of chunk(orders, BatchLimits.waveSize)) {
        // Fan-out: one child execution per invoice, all created before the wait.
        const issuing = wave.map((order) => this.IssueInvoice(batchId, size, order));

        // Fan-in: a rejected invoice is a result, not an exception, so the batch goes on. whenAll returns the
        // results in the order the invoices were created, not in the order they finished.
        invoices.push(...(await Skail.whenAll(issuing)));
      }

      const result = BatchResult.consolidate(batchId, invoices);
      await this.ReportStatus(BatchEvent.completed(batchId, result));
      return result;
    } catch (error) {
      if (!(error instanceof SkailNonDeterministicError))
        await this.ReportStatus(BatchEvent.failed(batchId, size, errorMessage(error)));
      throw error;
    }
  }

  /**
   * One invoice, as a child execution with its own history. An invoice that the city hall could not issue after
   * every attempt becomes a pending invoice, so the batch always completes.
   */
  @SkailFunction()
  async IssueInvoice(batchId: string, size: number, order: Order): Promise<Invoice> {
    let invoice: Invoice;
    try {
      invoice = await this.IssueAtCityHall(batchId, size, order);
    } catch (error) {
      if (error instanceof SkailNonDeterministicError) throw error;
      invoice = Invoice.pending(order, "city hall unavailable");
    }

    if (isAuthorized(invoice))
      await this.SendPdfToCustomer(batchId, size, invoice); // only an authorized invoice reaches the customer
    else await this.NotifyFinance(batchId, size, invoice); // rejected or pending: finance resolves it

    await this.ReportStatus(BatchEvent.invoiceDone(batchId, size, invoice));
    return invoice;
  }

  // The commands only delegate to BillingOperations, so their logic is tested without skail.

  /** A rejection is a result; an outage throws, so skail retries only this invoice. */
  @SkailCommand({ retryCount: 5 })
  async IssueAtCityHall(batchId: string, size: number, order: Order): Promise<Invoice> {
    return this.operations.issue(batchId, size, order);
  }

  @SkailCommand({ retryCount: 3 })
  async SendPdfToCustomer(batchId: string, size: number, invoice: Invoice): Promise<void> {
    await this.operations.sendPdf(batchId, size, invoice);
  }

  @SkailCommand({ retryCount: 3 })
  async NotifyFinance(batchId: string, size: number, invoice: Invoice): Promise<void> {
    await this.operations.notifyFinance(batchId, size, invoice);
  }

  /** Idempotent: the web app ignores a repeated event (same batch, stage and invoice). */
  @SkailCommand({ retryCount: 3 })
  async ReportStatus(evt: BatchEvent): Promise<void> {
    await this.operations.reportStatus(evt);
  }
}
