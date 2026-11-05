import { BatchEvent, isAuthorized, type Invoice, type Order } from "@skail-batch-billing/contracts";
import { CityHallUnavailableError, type CityHall } from "./city-hall.js";
import type { ProgressNotifier } from "./web.js";

/**
 * The I/O behind the commands, as plain async methods. The command wrappers only delegate here, so the
 * logic is unit tested without the skail runtime.
 */
export class BillingOperations {
  constructor(
    private readonly cityHall: CityHall,
    private readonly notifier: ProgressNotifier,
  ) {}

  /**
   * An outage throws, so skail retries only this invoice. The page is told about the retry on a best-effort basis:
   * if that fails, the outage is still the error the command throws.
   */
  async issue(batchId: string, size: number, order: Order): Promise<Invoice> {
    try {
      return await this.cityHall.issue(order);
    } catch (error) {
      if (error instanceof CityHallUnavailableError) {
        try {
          await this.notifier.notify(BatchEvent.retrying(batchId, size, order.number, error.message));
        } catch {
          // only a hint for the page
        }
      }
      throw error;
    }
  }

  /** The web app plays the finance team's inbox: the delivery is the event it receives. */
  async notifyFinance(batchId: string, size: number, invoice: Invoice): Promise<void> {
    if (isAuthorized(invoice))
      throw new Error(`invoice ${invoice.number} is authorized: finance has nothing to resolve`);
    await this.notifier.notify(BatchEvent.financeNotified(batchId, size, invoice));
  }

  /** The web app plays the customer's mailbox: the PDF "arrives" as the event it receives. */
  async sendPdf(batchId: string, size: number, invoice: Invoice): Promise<void> {
    if (!isAuthorized(invoice)) throw new Error(`invoice ${invoice.number} is not authorized: the PDF cannot be sent`);
    await this.notifier.notify(BatchEvent.pdfSent(batchId, size, invoice));
  }

  reportStatus(evt: BatchEvent): Promise<void> {
    return this.notifier.notify(evt);
  }
}
