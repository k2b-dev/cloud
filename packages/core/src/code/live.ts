import { type CodeCallEvent, CodeCallEventSchema, CodeRunEntriesInputSchema, codeDetailsKey, codeRunKey } from "@k2b/cloud/code";
import { sql } from "@k2b/cloud";
import type { LiveViewer } from "@k2b/cloud/events";
import { defineLive } from "@k2b/cloud/events";
import { z } from "zod";
import { codeLiveReaders } from "./access";
import { CodeIdSchema } from "./contracts";
import { findCode } from "./store";

/** Served beside `user` on Core's socket. SQL is confined to admission, access changes and reauthorize sweeps. */
export const codeLiveChannels = {
  codeRun: {
    eventOnly: true as const,
    reauthorize: true as const,
    scope: CodeRunEntriesInputSchema,
    keys: async ({ codeId, runId }: { codeId: string; runId: string }) => [codeRunKey(codeId, runId)],
    accessKey: (key: string) => key.split(":")[1]!,
    authorize: async (key: string, viewers: readonly LiveViewer[]) => {
      const [, codeId, runId] = key.split(":");
      if (!codeId || !runId) return new Set<string>();
      const [run] = await sql`SELECT id FROM code.runs WHERE code_id=${codeId} AND id=${runId}::uuid`;
      const code = run ? await findCode(codeId) : null;
      return code ? codeLiveReaders(code, viewers, undefined, true) : new Set<string>();
    },
  },
  codeDetails: {
    eventOnly: true as const,
    reauthorize: true as const,
    scope: z.object({ codeId: CodeIdSchema }).strict(),
    keys: async ({ codeId }: { codeId: string }) => [codeDetailsKey(codeId)],
    accessKey: (key: string) => key.slice("code.details:".length),
    authorize: async (key: string, viewers: readonly LiveViewer[]) => {
      const code = await findCode(key.slice("code.details:".length));
      return code ? codeLiveReaders(code, viewers, undefined, true) : new Set<string>();
    },
  },
  code: {
    eventOnly: true as const,
    reauthorize: true as const,
    scope: z.object({ codeId: CodeIdSchema }).strict(),
    keys: async ({ codeId }: { codeId: string }) => [codeId],
    authorize: async (key: string, viewers: readonly LiveViewer[]) => {
      const code = await findCode(key);
      return code ? codeLiveReaders(code, viewers) : new Set<string>();
    },
  },
};

const details = defineLive({ appId: "core", event: CodeCallEventSchema });
/** A hint failure cannot undo a committed call or prevent its external effect. */
export async function publishCodeCallHint(codeId: string, event: CodeCallEvent) {
  try {
    await details.publishTransient({ key: codeDetailsKey(codeId), data: event });
  } catch {
    // Keep the observation path SQL-free even when NATS is unavailable. No exception or payload text.
    console.warn("code_call_hint_unavailable", { runId: event.runId });
  }
}
