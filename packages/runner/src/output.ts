import {
  CODE_OUTPUT_INTERVAL_MS,
  CODE_OUTPUT_OPERATION,
  CODE_OUTPUT_STEP_LIMITS,
  CODE_OUTPUT_STEP_TEXT_FIELDS,
  type CodeOutputBatch,
  CodeOutputBatchSchema,
  codeOutputEntryLines,
  codeOutputStepsBudget,
} from "@k2b/cloud/code";

import type { RunnerLease, RunnerLeaseProof } from "@k2b/cloud/code/runner";
import { LIVE_LIMITS } from "@k2b/cloud/events/limits";

/** Engine-owned capture configuration: transient tiers keep their local console,
 * while only durable Code invocations send the production output stream. */
export function runnerOutputLimits(lease: Pick<RunnerLease, "runId" | "generation" | "token" | "trustTier" | "outputBytes">) {
  const bytes =
    LIVE_LIMITS.frameBytes -
    Buffer.byteLength(JSON.stringify({ runId: lease.runId, generation: lease.generation, token: lease.token, batch: null }));
  return {
    enabled: !["chat", "test"].includes(lease.trustTier),
    bytes,
    intervalMs: CODE_OUTPUT_INTERVAL_MS,
    operation: CODE_OUTPUT_OPERATION,
    step: {
      ...CODE_OUTPUT_STEP_LIMITS,
      budget: codeOutputStepsBudget(lease.runId, lease.generation, lease.outputBytes ?? LIVE_LIMITS.frameBytes),
      textBytes: Math.max(
        0,
        CODE_OUTPUT_STEP_LIMITS.textBytes - Math.ceil((LIVE_LIMITS.frameBytes - bytes) / CODE_OUTPUT_STEP_TEXT_FIELDS.length),
      ),
    },
  };
}

const sum = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/** Supervisor-owned pacing applies equally to console and direct bridge submissions.
 * Only loss counters wait in memory; accepted batches never form an HTTP queue.
 */
export class RunnerOutput {
  #lastAt: number | null = null;
  #pending = false;
  #sending?: Promise<void>;
  #seq = 0;
  #droppedLines = 0;
  #droppedBytes = 0;
  readonly budget: number;
  constructor(
    readonly send: (batch: CodeOutputBatch) => Promise<void>,
    proof: RunnerLeaseProof,
  ) {
    this.budget = LIVE_LIMITS.frameBytes - Buffer.byteLength(JSON.stringify({ ...proof, batch: null }));
  }
  async write(raw: unknown) {
    const batch = CodeOutputBatchSchema.parse(raw);
    if (this.#pending || (this.#lastAt !== null && Date.now() - this.#lastAt < CODE_OUTPUT_INTERVAL_MS)) {
      this.#droppedLines = sum(
        this.#droppedLines,
        sum(
          batch.droppedLines,
          batch.entries.reduce((total, line) => sum(total, codeOutputEntryLines(line)), 0),
        ),
      );
      this.#droppedBytes = sum(this.#droppedBytes, sum(batch.droppedBytes, Buffer.byteLength(JSON.stringify(batch.entries))));
      return;
    }
    const droppedLines = this.#droppedLines;
    const droppedBytes = this.#droppedBytes;
    this.#droppedLines = 0;
    this.#droppedBytes = 0;
    this.#pending = true;
    try {
      // Reserve wire space for aggregated counters and the supervisor's own sequence.
      const entries = [...batch.entries];
      const outgoing = {
        ...batch,
        seq: ++this.#seq,
        entries,
        droppedLines: sum(batch.droppedLines, droppedLines),
        droppedBytes: sum(batch.droppedBytes, droppedBytes),
      };
      while (
        (!CodeOutputBatchSchema.safeParse(outgoing).success || Buffer.byteLength(JSON.stringify(outgoing)) > this.budget) &&
        entries.length
      ) {
        const log = entries.findIndex((entry) => entry.kind !== "step");
        const [removed] = entries.splice(Math.max(0, log), 1);
        if (!removed) break;
        outgoing.droppedLines = sum(outgoing.droppedLines, codeOutputEntryLines(removed));
        outgoing.droppedBytes = sum(outgoing.droppedBytes, Buffer.byteLength(JSON.stringify(removed)));
      }
      if (Buffer.byteLength(JSON.stringify(outgoing)) > this.budget) throw new Error("runner_output_too_large");
      this.#sending = this.send(CodeOutputBatchSchema.parse(outgoing));
      await this.#sending;
    } finally {
      this.#lastAt = Date.now();
      this.#pending = false;
      this.#sending = undefined;
    }
  }
  async finish(signal: AbortSignal) {
    await this.#sending;
    if ((!this.#droppedLines && !this.#droppedBytes) || signal.aborted) return;
    const remaining = CODE_OUTPUT_INTERVAL_MS - (Date.now() - (this.#lastAt ?? 0));
    if (remaining > 0)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    if (!signal.aborted) await this.write({ seq: 1, entries: [], droppedLines: 0, droppedBytes: 0 });
  }
}
