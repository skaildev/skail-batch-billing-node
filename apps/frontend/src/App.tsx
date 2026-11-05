import { useCallback, useEffect, useState } from "react";
import { BatchLimits, isTerminalPhase, startState, type BatchView } from "@skail-batch-billing/contracts";
import { getBatch, getConfig, startBatch } from "./api";
import { BatchSizeSelect } from "./components/BatchSizeSelect";
import { InboxPanel } from "./components/InboxPanel";
import { InvoicesGrid } from "./components/InvoicesGrid";
import { ProgressBar } from "./components/ProgressBar";
import { StartButton } from "./components/StartButton";
import { StatusBadge } from "./components/StatusBadge";
import { SummaryCard } from "./components/SummaryCard";
import { formatMoney } from "./components/format";
import { useBatchStream } from "./hooks/useBatchStream";

const KEY = "batch-billing.batchId";

export function App() {
  const [batch, setBatch] = useState<BatchView | undefined>();
  const [size, setSize] = useState<number>(BatchLimits.defaultSize);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = useCallback(() => localStorage.removeItem(KEY), []);
  const active = batch && !isTerminalPhase(batch.phase) ? batch.batchId : undefined;
  useBatchStream(active, setBatch, forget);

  useEffect(() => {
    getConfig().then(
      (config) => setMonitorUrl(config.monitorUrl),
      () => {},
    );
  }, []);

  // reload keeps the controls right: the state always comes from the server
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (!saved) return;
    getBatch(saved).then((restored) => {
      if (!restored) return forget();
      setBatch(restored);
      setSize(restored.size);
      if (isTerminalPhase(restored.phase)) forget();
    }, forget);
  }, [forget]);

  const ui = startState(batch);

  async function onStart() {
    setBusy(true);
    setError(null);
    try {
      const started = await startBatch(size);
      localStorage.setItem(KEY, started.batchId);
      setBatch(started);
    } catch (e) {
      setError(`Could not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header>
        <h1>Batch billing</h1>
        <p className="subtitle">
          A skail function issues the invoices of a batch in waves of 10, one run per invoice, and consolidates the
          result when all of them finish. The simulated city hall is unavailable on about 1 call in 10, and skail
          retries only that invoice.
        </p>
      </header>

      <section className="controls">
        <BatchSizeSelect sizes={BatchLimits.sizes} value={size} disabled={!ui.enabled || busy} onChange={setSize} />
        <StartButton ui={ui} busy={busy} onClick={onStart} />
      </section>

      <section className="status">
        <StatusBadge phase={batch?.phase} />
        <span>{batch ? `${batch.done}/${batch.size}` : ""}</span>
        {monitorUrl && (
          <a href={monitorUrl} target="_blank" rel="noopener noreferrer">
            Open the skail Monitor
          </a>
        )}
      </section>
      {batch && <ProgressBar done={batch.done} total={batch.size} />}

      {(error ?? batch?.error) && <p className="error">{error ?? batch?.error}</p>}

      {batch?.result && <SummaryCard result={batch.result} />}

      <InvoicesGrid invoices={batch?.invoices ?? []} />

      <div className="inboxes">
        <InboxPanel
          title="Customer inbox"
          hint="PDFs received"
          columns={["#", "Customer", "File", "Amount"]}
          rows={(batch?.customerInbox ?? []).map((m) => ({
            key: m.number,
            cells: [m.number, m.customer, m.fileName, formatMoney(m.amount)],
          }))}
        />
        <InboxPanel
          title="Finance inbox"
          hint="tickets received"
          columns={["#", "Customer", "Status", "Reason"]}
          rows={(batch?.financeInbox ?? []).map((t) => ({
            key: t.number,
            cells: [t.number, t.customer, t.status, t.reason ?? ""],
          }))}
        />
      </div>

      <footer>
        Batch <code>{batch?.batchId ?? "-"}</code>
      </footer>
    </main>
  );
}
