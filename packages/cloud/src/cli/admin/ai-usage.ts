import { arg, command, flag } from "../index";
import { apiGet, printJsonOrTable } from "./shared";
import { AI_USAGE_RANGES, AI_USAGE_REASONS } from "../../shared/ai-usage";
import type { AiUsageReport, AiUsageRun } from "../../ai/usage";
const filters = {
  range: flag.enum(AI_USAGE_RANGES, { default: "30d", description: "Response/run period" }),
  until: flag.string({ description: "Fixed ISO end time; reuse report.query.until across pages" }),
  userId: flag.string({ name: "user", description: "User UUID or unassigned" }),
  modelProfileId: flag.string({ name: "model", description: "Model profile ID" }),
  providerModel: flag.string({ name: "provider-model", description: "Actual provider model" }),
  appId: flag.string({ name: "app", description: "Source application ID" }),
  kind: flag.enum(["chat", "background", "tool"] as const, { description: "Run kind (runs only)" }),
  status: flag.string({ description: "Run status, e.g. failed (runs only)" }),
  task: flag.string({ description: "Exact task or tool name (runs only)" }),
  errorCode: flag.string({ name: "error-code", description: "Stored error code (runs only)" }),
  search: flag.string({ description: "Search task and error text (runs/facets only)" }),
  rating: flag.enum(["up", "down"] as const, { description: "Rating (feedback only)" }),
  reason: flag.enum(AI_USAGE_REASONS, { description: "Feedback reason (feedback only)" }),
  sort: flag.enum(["runs", "tokens", "credits", "errors", "negative", "negativeRate"] as const, {
    default: "runs",
    description: "Comparison sort order",
  }),
  page: flag.int({ default: 1, min: 1 }),
  perPage: flag.int({ name: "per-page", default: 50, min: 1, max: 100 }),
};
// HTTP validation is authoritative, also for dynamically discovered CLI modules.
const params = (values: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) q.set(key, String(value));
  return q;
};
export const aiUsageCommands = [
  ...(["report", "users", "models", "tasks", "apps", "launches", "capabilities", "feedback", "runs"] as const).map((section) =>
    command(`ai usage ${section}`, {
      summary:
        section === "report"
          ? "Summarize AI usage and coverage; use --json for the complete report"
          : `List AI usage ${section}; supports --json and pagination`,
      flags: filters,
      run: async ({ ctx, flags }) => {
        const report = await apiGet<AiUsageReport>(ctx, `/api/admin/core/ai-usage/report?${params(flags)}`);
        if (section === "report" && ctx.options.output === "jsonl") return ctx.jsonLine(report);
        if (section === "report")
          return printJsonOrTable(
            ctx,
            report,
            [report.overview],
            [{ key: "runs" }, { key: "tokens" }, { key: "credits" }, { key: "failed" }, { key: "positive" }, { key: "negative" }],
          );
        const page = report[section];
        if (ctx.options.output === "jsonl") {
          for (const item of page.items) ctx.jsonLine(item);
          return;
        }
        if (ctx.options.output === "json") return ctx.json({ ...page, query: report.query, since: report.since, until: report.until });
        if (section === "runs")
          ctx.table(report.runs.items, [
            { key: "id" },
            { key: "kind" },
            { key: "task" },
            { key: "status" },
            { key: "userLabel" },
            { key: "modelProfileId" },
            { key: "error" },
          ]);
        else if (section === "feedback")
          ctx.table(report.feedback.items, [
            { key: "id" },
            { key: "userLabel" },
            { key: "modelProfileId" },
            { key: "rating" },
            { key: "comment" },
          ]);
        else if (section === "launches") ctx.table(report.launches.items, [{ key: "appId" }, { key: "chats" }, { key: "users" }]);
        else
          ctx.table(report[section].items, [
            { key: "id" },
            { key: "label" },
            { key: "providerModel" },
            { key: "runs" },
            { key: "tokens" },
            { key: "failed" },
            { key: "positive" },
            { key: "negative" },
            { key: "rated" },
          ]);
        ctx.print(`Page ${page.page}; ${page.total} total. Snapshot until ${report.until}`);
      },
    }),
  ),
  command("ai usage get", {
    summary: "Read one AI run, including its complete stored error and references",
    args: { kind: arg.required(), id: arg.required() },
    run: async ({ ctx, args }) => {
      const result = await apiGet<AiUsageRun>(
        ctx,
        `/api/admin/core/ai-usage/runs/${encodeURIComponent(args.kind)}/${encodeURIComponent(args.id)}`,
      );
      ctx.json(result);
    },
  }),
  command("ai usage facets", {
    summary: "Find user IDs, model profiles, provider models, apps or tasks for filtering",
    flags: {
      field: flag.enum(["userId", "modelProfileId", "providerModel", "appId", "task"] as const, { required: true }),
      search: flag.string(),
      range: filters.range,
    },
    run: async ({ ctx, flags }) => {
      const result = await apiGet<{ items: { id: string; label: string }[] }>(ctx, `/api/admin/core/ai-usage/facets?${params(flags)}`);
      if (ctx.options.output === "jsonl") {
        for (const item of result.items) ctx.jsonLine(item);
        return;
      }
      printJsonOrTable(ctx, result, result.items, [{ key: "id" }, { key: "label" }]);
    },
  }),
];
