import type { BatchEvent } from "@skail-batch-billing/contracts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProgressNotifier {
  notify(event: BatchEvent): Promise<void>;
}

/** Reports progress to the web app: POST {web}/internal/batches/{id}/events. */
export class HttpProgressNotifier implements ProgressNotifier {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  async notify(event: BatchEvent): Promise<void> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const response = await this.fetchImpl(`${base}internal/batches/${encodeURIComponent(event.batchId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the progress event`);
  }
}
