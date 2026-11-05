import {
  Orders,
  isAuthorized,
  isTerminalPhase,
  type BatchEvent,
  type BatchState,
  type InvoiceState,
  type InvoiceStatus,
  type InvoiceView,
} from "@skail-batch-billing/contracts";

interface Subscriber {
  onState: (state: BatchState) => void;
  onClose: () => void;
}

const stateOf = (status: InvoiceStatus): InvoiceState =>
  status === "Authorized" ? "Authorized" : status === "Rejected" ? "Rejected" : "Pending";

/**
 * In-memory state of the batches. The durable state lives in skail; this is only the UI view.
 * Events come from many child executions, so their order is not guaranteed: the most advanced state wins.
 */
export class BatchStore {
  readonly #batches = new Map<string, BatchState>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  create(batchId: string, size: number): BatchState {
    const invoices: InvoiceView[] = Orders.generate(batchId, size).map((p) => ({
      number: p.number,
      customer: p.customer,
      amount: p.amount,
      state: "Issuing",
      attempts: 1,
      reason: null,
      invoiceNumber: null,
    }));
    const batch: BatchState = {
      batchId,
      size,
      phase: "Starting",
      invoices,
      result: null,
      error: null,
      customerInbox: [],
      financeInbox: [],
    };
    this.#batches.set(batchId, batch);
    return batch;
  }

  get(batchId: string): BatchState | undefined {
    return this.#batches.get(batchId);
  }

  remove(batchId: string): void {
    this.#batches.delete(batchId);
    this.#close(batchId);
  }

  /** @returns true when the event changed the batch; false when ignored (unknown or finished batch, duplicate). */
  apply(event: BatchEvent): boolean {
    const batch = this.#batches.get(event.batchId);
    if (!batch || isTerminalPhase(batch.phase)) return false;

    const next = this.#next(batch, event);
    if (!next) return false;

    this.#publish({ ...next, phase: next.phase === "Starting" ? "Issuing" : next.phase });
    return true;
  }

  /** @returns the unsubscribe function. `onClose` is called when the batch reaches a terminal phase or is removed. */
  subscribe(batchId: string, onState: (state: BatchState) => void, onClose: () => void): () => void {
    const subscriber: Subscriber = { onState, onClose };
    let set = this.#subscribers.get(batchId);
    if (!set) this.#subscribers.set(batchId, (set = new Set()));
    set.add(subscriber);
    return () => void this.#subscribers.get(batchId)?.delete(subscriber);
  }

  #next(batch: BatchState, event: BatchEvent): BatchState | null {
    const { invoice } = event;
    switch (event.stage) {
      case "Started":
        return batch.phase === "Starting" ? { ...batch, phase: "Issuing" } : null;
      case "Retrying":
        return withInvoice(batch, event.number ?? 0, (n) =>
          n.state === "Issuing" ? { ...n, attempts: n.attempts + 1, reason: event.error ?? null } : null,
        );
      case "InvoiceDone":
        return invoice
          ? withInvoice(batch, invoice.number, (n) =>
              n.state === "Issuing"
                ? { ...n, state: stateOf(invoice.status), reason: invoice.reason, invoiceNumber: invoice.invoiceNumber }
                : null,
            )
          : null;
      case "PdfSent":
        return invoice && isAuthorized(invoice) && batch.customerInbox.every((m) => m.number !== invoice.number)
          ? {
              ...batch,
              customerInbox: [
                ...batch.customerInbox,
                {
                  number: invoice.number,
                  customer: invoice.customer,
                  amount: invoice.amount,
                  invoiceNumber: invoice.invoiceNumber,
                  protocol: invoice.protocol,
                  fileName: `${invoice.invoiceNumber}.pdf`,
                },
              ],
            }
          : null;
      case "FinanceNotified":
        return invoice && !isAuthorized(invoice) && batch.financeInbox.every((t) => t.number !== invoice.number)
          ? {
              ...batch,
              financeInbox: [
                ...batch.financeInbox,
                {
                  number: invoice.number,
                  customer: invoice.customer,
                  amount: invoice.amount,
                  status: invoice.status,
                  reason: invoice.reason,
                },
              ],
            }
          : null;
      case "Completed":
        return event.result ? { ...batch, phase: "Completed", result: event.result } : null;
      case "Failed":
        return { ...batch, phase: "Failed", error: event.error ?? "unknown error" };
    }
  }

  #publish(state: BatchState): void {
    this.#batches.set(state.batchId, state);
    for (const subscriber of [...(this.#subscribers.get(state.batchId) ?? [])]) subscriber.onState(state);
    if (isTerminalPhase(state.phase)) this.#close(state.batchId);
  }

  #close(batchId: string): void {
    const set = this.#subscribers.get(batchId);
    if (!set) return;
    this.#subscribers.delete(batchId);
    for (const subscriber of set) subscriber.onClose();
  }
}

function withInvoice(
  batch: BatchState,
  number: number,
  change: (invoice: InvoiceView) => InvoiceView | null,
): BatchState | null {
  const index = batch.invoices.findIndex((n) => n.number === number);
  const updated = index < 0 ? null : change(batch.invoices[index]!);
  if (!updated) return null;
  const invoices = [...batch.invoices];
  invoices[index] = updated;
  return { ...batch, invoices };
}
