import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  BatchLimits,
  doneCount,
  isTerminalPhase,
  type AppConfig,
  type BatchEvent,
  type BatchState,
  type BatchView,
} from "@skail-batch-billing/contracts";
import type { BatchStore } from "./batch-store.js";
import { SkailGatewayError, type SkailGateway } from "./gateway.js";

export interface AppOptions {
  store: BatchStore;
  gateway: SkailGateway;
  /** Optional link to the skail Monitor (MONITOR_URL), shown by the page. */
  monitorUrl?: string | null;
  /** Directory with the built front end (index.html + assets). Optional: tests do not need it. */
  staticDir?: string;
}

export function toView(batch: BatchState): BatchView {
  return { ...batch, done: doneCount(batch.invoices), active: !isTerminalPhase(batch.phase) };
}

export function createApp({ store, gateway, monitorUrl = null, staticDir }: AppOptions): FastifyInstance {
  const app = fastify();

  app.get("/healthz", async () => "ok");

  app.get("/api/config", async (): Promise<AppConfig> => ({
    sizes: [...BatchLimits.sizes],
    defaultSize: BatchLimits.defaultSize,
    monitorUrl: monitorUrl || null,
  }));

  app.post<{ Body: { size?: unknown } | null }>("/api/batches", async (request, reply) => {
    const size = request.body?.size ?? BatchLimits.defaultSize;
    if (!(BatchLimits.sizes as readonly unknown[]).includes(size)) {
      return reply
        .code(400)
        .send({ error: `Unsupported batch size ${String(size)}. Use one of: ${BatchLimits.sizes.join(", ")}` });
    }

    const batchId = randomUUID();
    const batch = store.create(batchId, size as number);
    try {
      await gateway.trigger(batchId, size as number);
    } catch (error) {
      store.remove(batchId);
      return reply.code(502).send({ error: messageOf(error) });
    }
    return toView(store.get(batchId) ?? batch);
  });

  app.get<{ Params: { id: string } }>("/api/batches/:id", async (request, reply) => {
    const batch = store.get(request.params.id);
    return batch ? toView(batch) : reply.code(404).send();
  });

  // called by the worker's ReportStatus command (and by the city hall retries and the deliveries)
  app.post<{ Params: { id: string }; Body: BatchEvent }>("/internal/batches/:id/events", async (request, reply) => {
    store.apply({ ...request.body, batchId: request.params.id });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/batches/:id/stream", (request, reply) => {
    const { id } = request.params;
    const current = store.get(id);
    if (!current) return reply.code(404).send();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (state: BatchState) => raw.write(`data: ${JSON.stringify(toView(state))}\n\n`);

    // subscribe before sending the snapshot: no update is lost
    const unsubscribe = store.subscribe(id, send, () => raw.end());
    raw.on("close", unsubscribe);
    send(current);
    if (isTerminalPhase(current.phase)) {
      unsubscribe();
      raw.end();
    }
  });

  if (staticDir) app.register(fastifyStatic, { root: staticDir });

  return app;
}

function messageOf(error: unknown): string {
  return error instanceof SkailGatewayError || error instanceof Error ? error.message : String(error);
}
