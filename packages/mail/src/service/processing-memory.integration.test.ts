import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { applyTestRuntimeEnv } from "../../../../scripts/fixtures/test-infra-env";
import { GUARD_LOADS, GUARD_PEAK_ABOVE_BASELINE_MIB, MiB } from "../../scripts/memory-load/model";
import { MAIL_PROCESSING_MEMORY_BUDGET_BYTES } from "./processing-memory-budget";

const summarySchema = z.object({
  manifestTotals: z.object({ messages: z.number().positive() }),
  correctnessTotals: z.object({
    complete: z.number(),
    failed: z.number(),
    pending: z.number(),
    missingMessages: z.number(),
    generatedAttachments: z.number(),
    storedAttachments: z.number(),
    missingAttachments: z.number(),
  }),
  peakAboveBaseline: z.number(),
  processingMemory: z.object({
    inFlightBytes: z.number(),
    inFlightCount: z.number(),
    waiting: z.number(),
    highWaterBytes: z.number(),
    largestAloneBytes: z.number(),
  }),
  errors: z.array(z.string()),
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Mail processing memory guard", () => {
  test("bounds the guard workload peak without losing messages or attachments", async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const directory = await mkdtemp(join(tmpdir(), "mail-memory-guard-"));
    // The runner requires a fresh output directory and retains its artifacts for diagnostics.
    const out = join(directory, "load");
    const summaryPath = join(out, "summary.json");
    const env = { ...process.env, CLOUD_HEAVY_LOCK: "held" };
    applyTestRuntimeEnv(env);
    // CLOUD_TEST_DATABASE_URL is only the administrative target. The load runner creates
    // its own random mail_*_test database before the default SQL handle's first query.
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(root, "packages/mail/scripts/memory-load.ts"),
        "--profile",
        "guard",
        "--only",
        GUARD_LOADS,
        "--json",
        "--out",
        out,
      ],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" },
    );
    let timedOut = false;
    // Leave time for pipe draining and diagnostics before bun:test's 300 s deadline.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 290_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      let summary: z.infer<typeof summarySchema>;
      try {
        summary = summarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
      } catch (error) {
        console.error(`Mail memory guard: ${summaryPath}; exit=${code}; timedOut=${timedOut}\n${stdout}\n${stderr}`);
        throw error;
      }
      const numbers = {
        code,
        timedOut,
        peakAboveBaseline: summary.peakAboveBaseline,
        peakLimit: GUARD_PEAK_ABOVE_BASELINE_MIB * MiB,
        processingMemory: summary.processingMemory,
        correctness: summary.correctnessTotals,
      };
      const diagnostic = `${summaryPath}\n${JSON.stringify(numbers)}`;
      try {
        expect(timedOut, diagnostic).toBe(false);
        expect(code, diagnostic).toBe(0);
        expect(summary.errors, diagnostic).toEqual([]);
        expect(summary.correctnessTotals.complete, diagnostic).toBe(summary.manifestTotals.messages);
        expect(summary.correctnessTotals, diagnostic).toMatchObject({ failed: 0, pending: 0, missingMessages: 0, missingAttachments: 0 });
        expect(summary.correctnessTotals.storedAttachments, diagnostic).toBe(summary.correctnessTotals.generatedAttachments);
        expect(summary.peakAboveBaseline, diagnostic).toBeLessThanOrEqual(GUARD_PEAK_ABOVE_BASELINE_MIB * MiB);
        expect(summary.processingMemory, diagnostic).toMatchObject({ inFlightBytes: 0, inFlightCount: 0, waiting: 0 });
        // Hydration reserved through the budget; without it the high-water would stay 0.
        expect(summary.processingMemory.highWaterBytes, diagnostic).toBeGreaterThan(0);
        expect(summary.processingMemory.highWaterBytes, diagnostic).toBeLessThanOrEqual(
          Math.max(MAIL_PROCESSING_MEMORY_BUDGET_BYTES, summary.processingMemory.largestAloneBytes),
        );
      } catch (error) {
        console.error(`Mail memory guard failed: ${diagnostic}`);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 300_000);
});
