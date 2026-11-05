import type { BatchPhase } from "@skail-batch-billing/contracts";

const LABELS: Record<BatchPhase, string> = {
  Starting: "Starting…",
  Issuing: "Issuing in parallel",
  Completed: "Completed",
  Failed: "Failed",
};

export function StatusBadge({ phase }: { phase: BatchPhase | undefined }) {
  const kind = !phase ? "idle" : phase === "Failed" ? "failed" : phase === "Completed" ? "done" : "active";
  return <span className={`badge ${kind}`}>{phase ? LABELS[phase] : "Idle"}</span>;
}
