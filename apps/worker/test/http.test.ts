import { describe, expect, it } from "vitest";
import { BatchEvent } from "@skail-batch-billing/contracts";
import { HttpProgressNotifier } from "../src/web.js";

describe("HttpProgressNotifier", () => {
  it("POSTs the event to {web}/internal/batches/{id}/events", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const notifier = new HttpProgressNotifier("http://web:8080", async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    const event = BatchEvent.started("a b", 20);
    await notifier.notify(event);

    expect(calls[0]!.url).toBe("http://web:8080/internal/batches/a%20b/events");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual(event);
  });

  it("throws when the web app answers an error", async () => {
    const notifier = new HttpProgressNotifier("http://web:8080/", async () => new Response("no", { status: 500 }));
    await expect(notifier.notify(BatchEvent.started("b", 1))).rejects.toThrow("500");
  });
});
