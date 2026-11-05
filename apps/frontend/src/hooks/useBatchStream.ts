import { useEffect } from "react";
import { isTerminalPhase, type BatchView } from "@skail-batch-billing/contracts";

/**
 * Follows a batch through SSE. EventSource reconnects by itself and the stream starts with the current
 * snapshot, so no update is lost. Closes at a terminal phase.
 */
export function useBatchStream(
  batchId: string | undefined,
  onState: (batch: BatchView) => void,
  onTerminal: () => void,
) {
  useEffect(() => {
    if (!batchId) return;
    const source = new EventSource(`/api/batches/${batchId}/stream`);
    source.onmessage = (event) => {
      const batch = JSON.parse(event.data) as BatchView;
      onState(batch);
      if (isTerminalPhase(batch.phase)) {
        source.close();
        onTerminal();
      }
    };
    return () => source.close();
    // callbacks are stable (state setters); the stream only depends on the batch id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);
}
