import type { ReactNode } from "react";

interface Props {
  title: string;
  /** What the inbox holds, shown next to the title, e.g. "PDFs received". */
  hint: string;
  columns: readonly string[];
  /** One entry per received item: the key and its cells. */
  rows: ReadonlyArray<{ key: number; cells: ReactNode[] }>;
}

/** An inbox (customer PDFs or finance tickets): title, counter and the received items. */
export function InboxPanel({ title, hint, columns, rows }: Props) {
  return (
    <section aria-label={title}>
      <h2>
        {title} <small>({hint})</small>{" "}
        <span className="count" aria-label="count">
          {rows.length}
        </span>
      </h2>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
