import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { BatchStore } from "./batch-store.js";
import { SkailApiGateway, skailOptionsFromEnvironment } from "./gateway.js";

const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const app = createApp({
  store: new BatchStore(),
  gateway: new SkailApiGateway(skailOptionsFromEnvironment()),
  monitorUrl: process.env.MONITOR_URL,
  staticDir,
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port, host });
console.log(`Batch billing web listening on http://${host}:${port} (static: ${staticDir})`);
