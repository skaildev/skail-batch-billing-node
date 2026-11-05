import type { InvoiceState, InvoiceView } from "@skail-batch-billing/contracts";
import { formatMoney } from "./format";

const LABELS: Record<InvoiceState, string> = {
  Issuing: "Issuing…",
  Authorized: "Authorized",
  Rejected: "Rejected",
  Pending: "Pending",
};

export function InvoicesGrid({ invoices }: { invoices: readonly InvoiceView[] }) {
  return (
    <section>
      <h2>Invoices</h2>
      <table aria-label="Invoices">
        <thead>
          <tr>
            <th>#</th>
            <th>Customer</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((n) => (
            <tr key={n.number} className={n.attempts > 1 ? "retried" : undefined}>
              <td>{n.number}</td>
              <td>{n.customer}</td>
              <td>{formatMoney(n.amount)}</td>
              <td>
                <span className={`pill ${n.state}`}>{LABELS[n.state]}</span>
              </td>
              <td>{n.attempts}</td>
              <td>{n.reason ?? n.invoiceNumber ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
