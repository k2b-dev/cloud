import { mutation } from "@k2b/stdlib/solid";
import { toast } from "@k2b/ui";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CodeRunReadModelSchema } from "../../contracts/code-read-model";
import type { CodeLive } from "./CodeLiveStrip";
import { type CodePageAutomation, type CodePageData, type CodePageReady, CodeReadSchema, coreQuery, StartSchema } from "./data";
import { type PageText, withQuery } from "./page-kit";

class StartFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

/** One retryable command for the head and the familiar overview action. No second run cache or navigation. */
export function createRunAction(options: {
  data: CodePageData;
  state: () => CodePageReady;
  live: CodeLive;
  text: PageText;
  reconcile: (code: CodePageReady["code"]) => void;
}) {
  const t = options.text.t;
  const [entrypoint, setEntrypoint] = createSignal<string | null>(null);
  const [approvalRequired, setApprovalRequired] = createSignal(false);
  const abort = new AbortController();
  let attempted: Intent | undefined;
  const runHref = (id: string) => withQuery(options.data.href, { tab: "runs", run: id });
  type Intent = { entrypoint: string; idempotencyKey: string };
  const command = mutation.create<{ runId: string; intent: Intent; waiting: boolean }, Intent>({
    mutation: async (intent, { abortSignal }) => {
      attempted = intent;
      setEntrypoint(intent.entrypoint);
      const waiting = options.live.runs().some((run) => run.state === "running");
      const result = await invokeCapabilityWithDataSchema(
        {
          appId: "core",
          capabilityId: "code.run",
          kind: "action",
          target: { type: "core.code", id: options.state().code.id },
          input: { entrypoint: intent.entrypoint, input: null },
          idempotencyKey: intent.idempotencyKey,
          signal: abortSignal,
        },
        StartSchema,
      );
      if (!result.ok) {
        // CONFLICT alone does not mean paused: read Core's canonical state, never inspect an English error message.
        if (result.error.status === 409) {
          const read = await invokeCapabilityWithDataSchema(
            { ...coreQuery("code.read", { codeId: options.state().code.id }), signal: abortSignal },
            CodeReadSchema,
          );
          if (read.ok && !abortSignal.aborted) options.reconcile(read.data.data.code);
        }
        throw new StartFailure(result.error.code, result.error.status);
      }
      return { runId: result.data.data.runId, intent, waiting };
    },
    onSuccess: ({ runId, intent, waiting }) => {
      const existing = options.live.runs().find((run) => run.id === runId);
      options.live.feed.run({
        id: runId,
        state: existing?.state ?? "queued",
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        entrypoint: intent.entrypoint,
        startedHere: true,
      });
      toast.success(waiting ? t().runWaiting : t().runStarted, { action: { label: t().viewRun, href: runHref(runId) } });
    },
    onError: (error) => {
      const intent = attempted;
      const paused = options.state().code.state === "paused";
      const approval = error instanceof StartFailure && error.code.startsWith("code_approval_");
      setApprovalRequired(approval);
      toast.error(
        paused
          ? t().pagesPaused
          : approval
            ? t().runApproval
            : error instanceof StartFailure && error.status === 503
              ? t().runNoConnection
              : t().runStartFailed,
        {
          duration: 0,
          action: paused
            ? null
            : approval
              ? { label: t().launchViewVersion, href: withQuery(options.data.href, { tab: "versions" }) }
              : {
                  label: t().tryAgain,
                  onClick: () => {
                    if (!command.loading() && intent) void command.mutate(intent);
                  },
                },
        },
      );
    },
  });
  // The live window bounds these receipts. Clear a receipt before the async read so a replay never repeats the toast.
  createEffect(() => {
    for (const run of options.live.runs()) {
      if (!run.startedHere || run.state === "queued" || run.state === "running") continue;
      options.live.feed.run({ ...run, startedHere: false });
      if (run.state !== "failed") continue;
      void invokeCapabilityWithDataSchema(
        { ...coreQuery("code.run.words", { codeId: options.state().code.id, runId: run.id }), signal: abort.signal },
        CodeRunReadModelSchema,
      )
        .then((result) => {
          if (abort.signal.aborted) return;
          const reason = result.ok ? result.data.data.reason : null;
          toast.error(reason || t().runOwnFailed, { duration: 0, action: { label: t().viewRun, href: runHref(run.id) } });
        })
        .catch(() => {
          if (!abort.signal.aborted) toast.error(t().runOwnFailed, { duration: 0, action: { label: t().viewRun, href: runHref(run.id) } });
        });
    }
  });
  onCleanup(() => {
    command.abort();
    abort.abort();
  });
  return {
    loading: command.loading,
    entrypoint,
    approvalRequired,
    start: (automation: CodePageAutomation) => {
      if (command.loading()) return;
      if (command.error() && entrypoint() === automation.entrypoint) {
        void command.retry();
        return;
      }
      void command.mutate({ entrypoint: automation.entrypoint, idempotencyKey: crypto.randomUUID() });
    },
  };
}
export type CodeRunAction = ReturnType<typeof createRunAction>;
