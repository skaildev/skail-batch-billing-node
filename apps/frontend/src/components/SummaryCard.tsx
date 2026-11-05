import type { BatchResult } from "@skail-batch-billing/contracts";
import { formatMoney } from "./format";

export function SummaryCard({ result }: { result: BatchResult }) {
  const items: Array<[string, string]> = [
    [String(result.authorized), "authorized (PDF sent)"],
    [String(result.rejected), "rejected (finance)"],
    [String(result.pending), "pending (finance)"],
    [formatMoney(result.amountBilled), "billed"],
  ];
  return (
    <section className="summary" aria-label="Summary">
      {items.map(([value, label]) => (
        <div key={label}>
          <span>{value}</span>
          <small>{label}</small>
        </div>
      ))}
    </section>
  );
}
