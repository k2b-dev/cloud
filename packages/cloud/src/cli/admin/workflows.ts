/**
 * Workflow runs from the command line.
 *
 * Everything the admin page shows, reachable from a script: whether anything
 * is broken, which runs failed, why a run started, and which effects escaped
 * without reporting back. Mutations require an explicit `--yes` decision.
 */
import { arg, command, confirmFlag, flag } from "../index";
import { apiGet, apiJson, formatMs, printJsonOrTable, queryString, readJsonInput, truncate } from "./shared";

type RunState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled" | "needs_attention";

export type WorkflowHealthRow = {
  appId: string;
  runs: Record<RunState, number>;
  strandedEffects: number;
  undispatchedEvents: number;
  oldestUndispatchedMs: number | null;
  worstStartLagMs: number | null;
};

export type WorkflowRunRow = {
  id: string;
  appId: string;
  workflowName: string;
  revision: number;
  mode: string;
  state: RunState;
  attempt: number;
  eventType: string | null;
  parentRunId: string | null;
  startLagMs: number | null;
  durationMs: number | null;
  createdAt: string;
};

export type WorkflowStepRow = {
  stepKey: string;
  kind: string;
  action: string | null;
  state: string;
  attempt: number;
  effectKey: string | null;
  effectState: string | null;
  durationMs: number | null;
};

export type WorkflowRunDetailRow = WorkflowRunRow & {
  scopeId: string;
  occurredAt: string;
  finishedAt: string | null;
  inputs: Record<string, unknown>;
  result: unknown;
  error: unknown;
  effectsUsed: Record<string, number>;
  effectBudget: Record<string, number>;
  eventData: Record<string, unknown> | null;
  eventPayloadExpired: boolean;
  steps: WorkflowStepRow[];
  children: Record<RunState, number>;
};

export type StrandedEffectRow = {
  runId: string;
  appId: string;
  workflowName: string;
  stepKey: string;
  action: string | null;
  effectState: string;
  ageMs: number;
};

export type UndispatchedEventRow = {
  id: string;
  appId: string;
  type: string;
  occurredAt: string;
  attempts: number;
  lastError: string | null;
};

const WINDOW_VALUES = ["1h", "24h", "7d", "30d"] as const;
const STATE_VALUES = ["all", "queued", "running", "waiting", "succeeded", "failed", "canceled", "needs_attention"] as const;
const MODE_VALUES = ["all", "execute", "dryRun"] as const;

const windowFlag = () => flag.enum(WINDOW_VALUES, { default: "24h", description: "Lookback window" });

/** A budget reads as `emails 3/10`, which is the only form that shows headroom. */
const budgetSummary = (used: Record<string, number>, budget: Record<string, number>): string => {
  const dimensions = [...new Set([...Object.keys(budget), ...Object.keys(used)])];
  if (dimensions.length === 0) return "-";
  return dimensions.map((dimension) => `${dimension} ${used[dimension] ?? 0}/${budget[dimension] ?? "∞"}`).join(", ");
};

export const workflowCommands = [
  command("workflows health", {
    summary: "Show per-app workflow health",
    description:
      "One row per app. `stranded` counts effects that left the process and never reported back — a replay refuses to repeat those, so each is a run that cannot continue on its own. `undispatched` counts events that never turned into runs, which is what a workflow that silently stopped looks like.",
    examples: ["cld admin workflows health", "cld admin workflows health --window 7d --json"],
    flags: { window: windowFlag() },
    run: async ({ ctx, flags }) => {
      const raw = await apiGet<{ items: WorkflowHealthRow[] }>(ctx, `/api/gateway/workflows${queryString({ window: flags.window })}`);
      printJsonOrTable(
        ctx,
        raw,
        raw.items.map((row) => ({
          app: row.appId,
          active: row.runs.queued + row.runs.running + row.runs.waiting,
          succeeded: row.runs.succeeded,
          failed: row.runs.failed,
          attention: row.runs.needs_attention,
          stranded: row.strandedEffects,
          undispatched: row.undispatchedEvents,
          worstLag: formatMs(row.worstStartLagMs),
        })),
        [
          { key: "app", label: "App" },
          { key: "active", label: "Active" },
          { key: "succeeded", label: "Succeeded" },
          { key: "failed", label: "Failed" },
          { key: "attention", label: "Attention" },
          { key: "stranded", label: "Stranded" },
          { key: "undispatched", label: "Undispatched" },
          { key: "worstLag", label: "Worst lag" },
        ],
      );
    },
  }),

  command("workflows runs", {
    summary: "List workflow runs, newest first",
    description:
      "Child runs of a fan-out are hidden unless `--children` is passed; a bulk operation over ten thousand records would otherwise bury everything else. `lag` is the gap between the occurrence that caused a run and the run actually starting — the drift that says a workflow is falling behind.",
    examples: [
      "cld admin workflows runs --state failed",
      "cld admin workflows runs --app mail --window 7d --json",
      "cld admin workflows runs --state needs_attention",
    ],
    flags: {
      app: flag.string({ description: "Restrict to one app" }),
      workflow: flag.string({ description: "Restrict to one workflow id" }),
      parent: flag.string({ description: "Restrict to direct children of one run" }),
      state: flag.enum(STATE_VALUES, { default: "all", description: "Run state" }),
      mode: flag.enum(MODE_VALUES, { default: "all", description: "Execute or dry run" }),
      children: flag.boolean({ description: "Include child runs of a fan-out" }),
      window: windowFlag(),
      page: flag.int({ default: 1, description: "Page number" }),
      limit: flag.int({ default: 50, description: "Rows per page" }),
    },
    run: async ({ ctx, flags }) => {
      const raw = await apiGet<{ items: WorkflowRunRow[] }>(
        ctx,
        `/api/gateway/workflows/runs${queryString({
          app: flags.app,
          workflow: flags.workflow,
          parent: flags.parent,
          state: flags.state,
          mode: flags.mode,
          children: flags.children ? "true" : undefined,
          window: flags.window,
          page: flags.page,
          per_page: flags.limit,
        })}`,
      );
      printJsonOrTable(
        ctx,
        raw,
        raw.items.map((run) => ({
          id: run.id,
          app: run.appId,
          workflow: truncate(`${run.workflowName} r${run.revision}`, 34),
          cause: run.eventType ?? "direct",
          state: run.state,
          attempts: run.attempt,
          lag: formatMs(run.startLagMs),
          duration: formatMs(run.durationMs),
        })),
        [
          { key: "id", label: "Run" },
          { key: "app", label: "App" },
          { key: "workflow", label: "Workflow" },
          { key: "cause", label: "Cause" },
          { key: "state", label: "State" },
          { key: "attempts", label: "Attempts" },
          { key: "lag", label: "Lag" },
          { key: "duration", label: "Duration" },
        ],
      );
    },
  }),

  command("workflows show", {
    summary: "Show one run with its steps, cause and effects",
    description: "The table lists steps; `--json` additionally carries the inputs, the event payload, the result and the child-run counts.",
    examples: ["cld admin workflows show <run-id>", "cld admin workflows show <run-id> --json"],
    args: { run: arg.required({ description: "Run id" }) },
    run: async ({ ctx, args }) => {
      const raw = await apiGet<WorkflowRunDetailRow>(ctx, `/api/gateway/workflows/runs/${encodeURIComponent(args.run)}`);
      // The header lines are for humans; --json already carries all of it.
      if (ctx.options.output !== "json") {
        ctx.print(`${raw.workflowName} r${raw.revision} · ${raw.state} · ${raw.appId}`);
        ctx.print(
          `cause ${raw.eventType ?? "direct invocation"} · attempt ${raw.attempt} · lag ${formatMs(raw.startLagMs)} · ${formatMs(raw.durationMs)}`,
        );
        ctx.print(`effects ${budgetSummary(raw.effectsUsed, raw.effectBudget)}`);
        const children = Object.entries(raw.children).filter(([, count]) => count > 0);
        if (children.length > 0) ctx.print(`children ${children.map(([state, count]) => `${count} ${state}`).join(", ")}`);
      }
      printJsonOrTable(
        ctx,
        raw,
        raw.steps.map((step) => ({
          step: truncate(step.stepKey, 30),
          action: step.action ?? step.kind,
          state: step.state,
          effect: step.effectState ?? "-",
          attempts: step.attempt + 1,
          duration: formatMs(step.durationMs),
        })),
        [
          { key: "step", label: "Step" },
          { key: "action", label: "Action" },
          { key: "state", label: "State" },
          { key: "effect", label: "Effect" },
          { key: "attempts", label: "Attempts" },
          { key: "duration", label: "Duration" },
        ],
      );
    },
  }),

  command("workflows cancel", {
    summary: "Cancel a queued, running or waiting workflow run",
    description:
      "Requests cooperative cancellation. A queued run stops immediately; running or waiting work stops at its next heartbeat. Completed external effects are not undone.",
    examples: ["cld admin workflows cancel <run-id> --yes", "cld admin workflows cancel <run-id> --yes --json"],
    args: { run: arg.required({ description: "Run id" }) },
    flags: { yes: confirmFlag("Confirm workflow run cancellation") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to cancel a workflow run without --yes.");
      const raw = await apiJson<{ canceled: true }>(ctx, "POST", `/api/gateway/workflows/runs/${encodeURIComponent(args.run)}/cancel`);
      if (ctx.options.output === "json") ctx.json(raw);
      else ctx.print(`Cancellation requested for ${args.run}.`);
    },
  }),

  command("workflows effects", {
    summary: "List effects that escaped without reporting back",
    description:
      "Each row is a step that told an external system to do something and never learned whether it landed. A replay will not repeat them — repeating is how the same message goes out twice — so a human decides. This is the queue to work through after an incident.",
    examples: ["cld admin workflows effects", "cld admin workflows effects --app mail --json"],
    flags: {
      app: flag.string({ description: "Restrict to one app" }),
      page: flag.int({ default: 1, description: "Page number" }),
      limit: flag.int({ default: 100, description: "Rows per page" }),
    },
    run: async ({ ctx, flags }) => {
      const raw = await apiGet<{ items: StrandedEffectRow[] }>(
        ctx,
        `/api/gateway/workflows/effects${queryString({ app: flags.app, page: flags.page, limit: flags.limit })}`,
      );
      printJsonOrTable(
        ctx,
        raw,
        raw.items.map((effect) => ({
          run: effect.runId,
          app: effect.appId,
          workflow: truncate(effect.workflowName, 28),
          step: truncate(effect.stepKey, 26),
          action: effect.action ?? "-",
          effect: effect.effectState,
          age: formatMs(effect.ageMs),
        })),
        [
          { key: "run", label: "Run" },
          { key: "app", label: "App" },
          { key: "workflow", label: "Workflow" },
          { key: "step", label: "Step" },
          { key: "action", label: "Action" },
          { key: "effect", label: "State" },
          { key: "age", label: "Age" },
        ],
      );
    },
  }),

  command("workflows resolve", {
    summary: "Resolve a workflow effect that needs attention",
    description:
      "Confirm whether an ambiguous external effect succeeded or failed. Success records the supplied output and resumes the pinned plan; failure settles the step and run. This never repeats the effect.",
    examples: [
      'cld admin workflows resolve <run-id> <step-key> --decision succeeded --result \'{"id":"m-1"}\' --yes',
      "cld admin workflows resolve <run-id> <step-key> --decision failed --message 'provider rejected it' --yes",
    ],
    args: {
      run: arg.required({ description: "Run id" }),
      step: arg.required({ description: "Step key" }),
    },
    flags: {
      decision: flag.enum(["succeeded", "failed"] as const, { required: true, description: "Confirmed effect outcome" }),
      result: flag.input({ description: "JSON output for a succeeded effect, or @file/-" }),
      message: flag.string({ description: "Failure explanation" }),
      code: flag.string({ description: "Stable failure code" }),
      yes: confirmFlag("Confirm the effect resolution"),
    },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to resolve a workflow effect without --yes.");
      const resolution =
        flags.decision === "succeeded"
          ? {
              state: "succeeded" as const,
              ...(flags.result ? { output: await readJsonInput<unknown>(flags.result, "effect result") } : {}),
            }
          : {
              state: "failed" as const,
              message: flags.message?.trim() || "effect confirmed failed by operator",
              ...(flags.code ? { code: flags.code } : {}),
            };
      const raw = await apiJson<{ resolved: true }>(
        ctx,
        "POST",
        `/api/gateway/workflows/runs/${encodeURIComponent(args.run)}/attention/${encodeURIComponent(args.step)}`,
        resolution,
      );
      if (ctx.options.output === "json") ctx.json(raw);
      else ctx.print(`Resolved ${args.run} ${args.step} as ${flags.decision}.`);
    },
  }),

  command("workflows events", {
    summary: "List events that never turned into runs",
    description:
      "An event that matched no activation, or whose dispatch failed. This is what a workflow that silently stopped firing looks like — the occurrence happened, nothing ran, and nothing errored where anyone would see it.",
    examples: ["cld admin workflows events", "cld admin workflows events --app grids --json"],
    flags: {
      app: flag.string({ description: "Restrict to one app" }),
      page: flag.int({ default: 1, description: "Page number" }),
      limit: flag.int({ default: 100, description: "Rows per page" }),
    },
    run: async ({ ctx, flags }) => {
      const raw = await apiGet<{ items: UndispatchedEventRow[] }>(
        ctx,
        `/api/gateway/workflows/events${queryString({ app: flags.app, page: flags.page, limit: flags.limit })}`,
      );
      printJsonOrTable(
        ctx,
        raw,
        raw.items.map((event) => ({
          id: event.id,
          app: event.appId,
          type: event.type,
          occurred: event.occurredAt,
          attempts: event.attempts,
          error: truncate(event.lastError ?? "-", 44),
        })),
        [
          { key: "id", label: "Event" },
          { key: "app", label: "App" },
          { key: "type", label: "Type" },
          { key: "occurred", label: "Occurred" },
          { key: "attempts", label: "Attempts" },
          { key: "error", label: "Last error" },
        ],
      );
    },
  }),
];
