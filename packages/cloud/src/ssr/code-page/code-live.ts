import { i18n } from "@k2b/stdlib";
import { toast } from "@k2b/ui";
import { z } from "zod";
import { liveConnection } from "../../browser/live";
import { reloadOnce } from "../../browser/reload";
import { CodeCallEventSchema, CodeRunEventSchema } from "../../code/live-events";
import { CodeOutputEventSchema, type CodeOutputWindow } from "../../code/output";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { stopped: "Run updates stopped. Reload to see the current state.", reload: "Reload" },
    de: { stopped: "Lauf-Updates wurden angehalten. Lade die Seite neu, um den aktuellen Stand zu sehen.", reload: "Neu laden" },
  },
});

/** Subscribe before loading the initial run snapshot. Return the disposer to the island's cleanup. */
export function followCodeRuns(
  codeId: string,
  onRun: (event: { runId: string; state: "queued" | "running" | "succeeded" | "failed" | "skipped"; at: string }) => void,
  onResync?: () => void | Promise<void>,
  /** The live position the page's snapshot belongs to; without it the page refreshes once after admission. */
  cursor: string | null = null,
): () => void {
  let stopped = false;
  const recover = () => {
    if (stopped) return;
    if (reloadOnce(`code:live:${codeId}`)) return;
    const t = messages.resolve([document.documentElement.lang || "en"]).t;
    toast(t.stopped, { duration: 0, action: { label: t.reload, onClick: () => window.location.reload() } });
  };
  const refresh = async () => {
    if (onResync) await onResync();
    else recover();
  };
  let admitted = false;
  const subscription = liveConnection("/api/ai/live").subscribe(
    "code",
    { codeId },
    {
      cursor,
      parse: (data) => CodeRunEventSchema.parse(data),
      apply: async (events) => {
        for (const { data } of events) {
          if (stopped) return;
          onRun({ runId: data.runId, state: data.state, at: data.at });
        }
      },
      resync: refresh,
      caughtUp: (caughtUp) => {
        if (!caughtUp || admitted) return;
        admitted = true;
        // No SSR cursor: cover changes between the page snapshot and subscription admission once.
        if (cursor === null && onResync) void refresh().catch(recover);
      },
      revoked: recover,
      unavailable: recover,
    },
  );
  return () => {
    stopped = true;
    subscription.close();
  };
}

const detailEvent = z.discriminatedUnion("type", [CodeCallEventSchema, CodeOutputEventSchema]);
export type CodeDetailEvent = z.infer<typeof detailEvent>;

/** Editors only. Subscribe before reading a covering code.run.read snapshot; resync must replace that snapshot.
 * Output deltas are bounded by frameBytes. A sequence gap (including discarded batches) requests the shared tail.
 * Render text parts as text nodes and secret parts by name; never inject HTML or interpret terminal escapes.
 */
export function followCodeDetails(
  codeId: string,
  onEvent: (event: CodeDetailEvent) => void,
  resync: () => Promise<void>,
  initial: Readonly<Record<string, Pick<CodeOutputWindow, "generation" | "seq">>> = {},
  onUnavailable?: () => void,
): () => void {
  const positions = new Map(Object.entries(initial));
  let admitted = false;
  const recover = () => {
    if (onUnavailable) return onUnavailable();
    if (reloadOnce(`code:details:${codeId}`)) return;
    const t = messages.resolve([document.documentElement.lang || "en"]).t;
    toast(t.stopped, { duration: 0, action: { label: t.reload, onClick: () => window.location.reload() } });
  };
  const subscription = liveConnection("/api/ai/live").subscribe(
    "codeDetails",
    { codeId },
    {
      cursor: null,
      parse: (data) => detailEvent.parse(data),
      apply: async (events) => {
        for (const { data } of events) {
          if (data.type === "code.output") {
            const previous = positions.get(data.runId);
            if (
              previous &&
              (data.generation < previous.generation || (data.generation === previous.generation && data.seq <= previous.seq))
            )
              continue;
            if (!previous || data.generation !== previous.generation || data.seq !== previous.seq + 1) await resync();
            positions.set(data.runId, { generation: data.generation, seq: data.seq });
          }
          onEvent(data);
        }
      },
      resync,
      caughtUp: (caughtUp) => {
        if (!caughtUp || admitted) return;
        admitted = true;
        void resync().catch(recover);
      },
      revoked: recover,
      unavailable: recover,
    },
  );
  return () => subscription.close();
}
