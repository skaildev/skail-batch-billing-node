import type { AppConfig, BatchView } from "@skail-batch-billing/contracts";

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `HTTP ${res.status}`);
}

export async function startBatch(size: number): Promise<BatchView> {
  const res = await fetch("/api/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size }),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function getBatch(batchId: string): Promise<BatchView | null> {
  const res = await fetch(`/api/batches/${batchId}`);
  return res.ok ? res.json() : null;
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw await failure(res);
  return res.json();
}
