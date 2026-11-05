import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkail } from "@skail/build";

describe("skail build", () => {
  it("accepts the worker (no forbidden imports) and lists the functions and commands as <workload>/<method>", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batch-billing-bundle-"));
    try {
      const manifest = await buildSkail({
        entryPoint: "src/skail-functions.ts",
        workload: "batch-billing:v0.0.1",
        outfile: join(dir, "skail-functions.mjs"),
        manifestFile: join(dir, "manifest.json"),
      });

      expect(manifest.methods.map((m) => [m.kind, m.uri]).sort()).toEqual([
        ["command", "batch-billing:v0.0.1/IssueAtCityHall"],
        ["command", "batch-billing:v0.0.1/NotifyFinance"],
        ["command", "batch-billing:v0.0.1/ReportStatus"],
        ["command", "batch-billing:v0.0.1/SendPdfToCustomer"],
        ["function", "batch-billing:v0.0.1/BillBatch"],
        ["function", "batch-billing:v0.0.1/IssueInvoice"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
