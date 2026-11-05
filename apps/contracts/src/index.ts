// Shared by web, worker and front end. It also goes into the skail bundle, so it has only types, constants
// and pure functions: no Node I/O imports, which the skail build rejects.

export const BatchLimits = {
  sizes: [10, 20, 50],
  defaultSize: 20,
  maxSize: 50,
  /** Invoices issued at the same time. The batch runs in waves of this size, so the city hall is not flooded. */
  waveSize: 10,
} as const;

/** Order to be invoiced. `id` is also the idempotency key at the city hall. */
export interface Order {
  id: string;
  number: number;
  customer: string;
  amount: number;
}

const cents = (value: number): number => Math.round(value * 100) / 100;

export const Orders = {
  /** Pure arithmetic over the arguments, so it is safe to call from a function (deterministic). */
  generate(batchId: string, size: number): Order[] {
    return Array.from({ length: size }, (_, i) => {
      const n = i + 1;
      return {
        id: `${batchId}-${n}`,
        number: n,
        customer: `Customer ${String(n).padStart(3, "0")}`,
        amount: cents(100 + ((n * 37) % 900) + ((n * 13) % 100) / 100),
      };
    });
  },
};

export type InvoiceStatus = "Authorized" | "Rejected" | "Pending";

export interface Invoice {
  number: number;
  customer: string;
  amount: number;
  status: InvoiceStatus;
  invoiceNumber: string | null;
  protocol: string | null;
  reason: string | null;
}

export const Invoice = {
  pending(order: Order, reason: string): Invoice {
    return {
      number: order.number,
      customer: order.customer,
      amount: order.amount,
      status: "Pending",
      invoiceNumber: null,
      protocol: null,
      reason,
    };
  },
};

/** A function, not a property: the invoice travels as JSON between the worker and the web app. */
export function isAuthorized(invoice: Pick<Invoice, "status">): boolean {
  return invoice.status === "Authorized";
}

export interface BatchResult {
  batchId: string;
  total: number;
  authorized: number;
  rejected: number;
  pending: number;
  amountBilled: number;
}

export const BatchResult = {
  consolidate(batchId: string, invoices: readonly Invoice[]): BatchResult {
    const count = (status: InvoiceStatus) => invoices.filter((n) => n.status === status).length;
    return {
      batchId,
      total: invoices.length,
      authorized: count("Authorized"),
      rejected: count("Rejected"),
      pending: count("Pending"),
      amountBilled: cents(invoices.filter(isAuthorized).reduce((sum, n) => sum + n.amount, 0)),
    };
  },
};

export type BatchStage =
  "Started" | "Retrying" | "PdfSent" | "FinanceNotified" | "InvoiceDone" | "Completed" | "Failed";

/** Progress sent by the worker to the web app (ReportStatus command and city hall retries). */
export interface BatchEvent {
  batchId: string;
  stage: BatchStage;
  total: number;
  number?: number;
  invoice?: Invoice | null;
  result?: BatchResult | null;
  error?: string | null;
}

export const BatchEvent = {
  started: (batchId: string, total: number): BatchEvent => ({ batchId, stage: "Started", total }),
  retrying: (batchId: string, total: number, number: number, error: string): BatchEvent => ({
    batchId,
    stage: "Retrying",
    total,
    number,
    error,
  }),
  invoiceDone: (batchId: string, total: number, invoice: Invoice): BatchEvent => ({
    batchId,
    stage: "InvoiceDone",
    total,
    number: invoice.number,
    invoice,
  }),
  /** The customer received the PDF of an authorized invoice. */
  pdfSent: (batchId: string, total: number, invoice: Invoice): BatchEvent => ({
    batchId,
    stage: "PdfSent",
    total,
    number: invoice.number,
    invoice,
  }),
  /** Finance received a ticket for a rejected or pending invoice. */
  financeNotified: (batchId: string, total: number, invoice: Invoice): BatchEvent => ({
    batchId,
    stage: "FinanceNotified",
    total,
    number: invoice.number,
    invoice,
  }),
  completed: (batchId: string, result: BatchResult): BatchEvent => ({
    batchId,
    stage: "Completed",
    total: result.total,
    result,
  }),
  failed: (batchId: string, total: number, error: string): BatchEvent => ({ batchId, stage: "Failed", total, error }),
};

// ---- web view: what GET /api/batches/{id} and the SSE stream return ----

export type BatchPhase = "Starting" | "Issuing" | "Completed" | "Failed";
export type InvoiceState = "Issuing" | "Authorized" | "Rejected" | "Pending";

export interface InvoiceView {
  number: number;
  customer: string;
  amount: number;
  state: InvoiceState;
  attempts: number;
  reason: string | null;
  invoiceNumber: string | null;
}

/** A PDF that reached the customer (only authorized invoices). */
export interface CustomerMail {
  number: number;
  customer: string;
  amount: number;
  invoiceNumber: string | null;
  protocol: string | null;
  fileName: string;
}

/** A ticket that reached finance (only rejected or pending invoices). */
export interface FinanceTicket {
  number: number;
  customer: string;
  amount: number;
  status: InvoiceStatus;
  reason: string | null;
}

export interface BatchState {
  batchId: string;
  size: number;
  phase: BatchPhase;
  invoices: InvoiceView[];
  result: BatchResult | null;
  error: string | null;
  customerInbox: CustomerMail[];
  financeInbox: FinanceTicket[];
}

export interface BatchView extends BatchState {
  done: number;
  active: boolean;
}

export interface AppConfig {
  sizes: number[];
  defaultSize: number;
  monitorUrl: string | null;
}

export function isTerminalPhase(phase: BatchPhase): boolean {
  return phase === "Completed" || phase === "Failed";
}

export function doneCount(invoices: readonly InvoiceView[]): number {
  return invoices.filter((n) => n.state !== "Issuing").length;
}

export interface UiState {
  label: string;
  enabled: boolean;
}

/** Start (and the size dropdown) are available only when there is no batch in progress. */
export function startState(batch: Pick<BatchState, "phase"> | undefined): UiState {
  return !batch || isTerminalPhase(batch.phase)
    ? { label: "Start", enabled: true }
    : { label: "Issuing…", enabled: false };
}

/** Splits the orders into waves (one whenAll per wave). Pure, so it is safe inside a function. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const waves: T[][] = [];
  for (let i = 0; i < items.length; i += size) waves.push(items.slice(i, i + size));
  return waves;
}
