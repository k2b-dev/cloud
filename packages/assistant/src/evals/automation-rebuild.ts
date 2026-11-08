import { type CodeSdkInvocation, CodeTestCaseSchema, CodeTestMockSchema } from "@k2b/cloud/code";
import { z } from "zod";
import mockExamples from "./fixtures/automation-rebuild-mocks-v1.json";
import mail from "./fixtures/mail-rule-v1.json";
import agentRoutine from "./fixtures/routine-agent-v1.json";
import routine from "./fixtures/routine-v1.json";

export const AUTOMATION_REBUILD_MOCKS = z.array(CodeTestMockSchema).parse(mockExamples);

/** Fictional v1 exports checked against the owning export schemas in automation-rebuild.test.ts. */
export const AUTOMATION_REBUILD_CASES = [
  {
    name: "mail-rule",
    export: mail,
    mockExamples: [AUTOMATION_REBUILD_MOCKS[0]!],
    request:
      "Explain this exported rule and draft its equivalent as mailbox-owned Code. Keep it inactive. Use the supplied fictional mailbox only in fictional tests; discover its real replacement before submission. The list mock probes paging only; it does not require polling for this event-driven rule.",
    review: [
      "Explains disabled source, priority 7/order 1, chosen current version, sender filter and conversation-local tag effect.",
      "Uses the Skill's mail-automation pattern, adding only the exported sender/tag behavior. Unwraps Mail Query data, preserves unrelated tags and the current revision guard, without polling. If listing, follows opaque page.nextCursor only while hasMore, with a fixed bound and visible incomplete results; never infers completion from array length.",
      "Covers matching and nonmatching arrivals, action refusal, revision conflict and repeat delivery without duplicate tags; this tag action declares idempotency none.",
    ],
  },
  {
    name: "routine",
    export: routine,
    request:
      "Explain this exported routine and draft its equivalent as personal Code. I explicitly choose a NEW general Chat conversation as delivery target instead of the original Assistant chat. Discover and let me select that target; do not guess an ID. If discovery or creation is unavailable, ask me to create the conversation and provide its link. Preserve the one-time UTC instant and keep it inactive.",
    review: [
      "Explains prompt, paused state, one-time instant/timezone, empty grants and original Assistant target.",
      "Uses the Skill's weekly-report scheduling/generation pattern with the exported once instant; unwraps core.ai.generate Query data and keeps Chat Action replies direct. Calls out the explicitly requested target change.",
      "Tests fixed-time generation, provider refusal, Chat refusal and retry without duplicate delivery; no live calls.",
    ],
  },
  {
    name: "routine-agent",
    export: agentRoutine,
    mockExamples: AUTOMATION_REBUILD_MOCKS.slice(1),
    expectedInvocation: {
      call: {
        capability: "core.ai.chat.run",
        target: { type: "core.ai.chat", id: agentRoutine.items[0]!.targetChat.id },
        refs: {},
        input: { prompt: agentRoutine.items[0]!.prompt },
      },
      metadata: { idempotencyKey: "routine-agent:monday-review" },
    } satisfies CodeSdkInvocation,
    request:
      "Explain this exported open-ended routine and draft equivalent personal Code owned by the routine's owner. Preserve the exact prompt, recurring Europe/Berlin wall-clock schedule and original Gustav chat. Schedule core.ai.chat.run, with tools, within the owner's budget and approvals. Discover its actual SDK contract; if unavailable, explain the dependency and keep an inactive draft. Use only fictional resources and mocks for tests. Keep the replacement inactive.",
    review: [
      "Explains paused source state, prompt, owner, original Gustav chat, cron 0 9 * * 1 in Europe/Berlin, Mail query grants and fixed-input restrictions, and the mandate's historical status.",
      "Uses personal Code owned by the routine owner and app.schedule with cron and timeZone, with a stable name as in the Skill's schedules/chat.run pattern. Matches the capability, target and prompt in expectedInvocation; its key value is illustrative. core.ai.chat.run targets core.ai.chat ExMndy, input is {prompt} with the exact exported instructions, optional context is source data only, and the required idempotency key is invocation metadata (supplied alongside prompt in the generated SDK). No chatId or grants in domain input.",
      "Retains the tool-using Gustav turn and its chat context; does not substitute core.ai.generate, delivery-only work, a new chat, general Chat, or a precompiled sequence of tool choices.",
      "Explains that the old mandate allowed three Mail queries and no actions: conversation.list and message.list were fixed to ExRevw, while message.read had no mailbox restriction. The new turn uses the owner's current tools across their accessible resources and can request changes under chat approvals; it is not confined to that query list or mailbox. Requires the person to review this difference before activation; imports no authority.",
      "Uses fictional core.ai.chat.run replies to test exact prompt/chat, owner mismatch, budget refusal, chat_busy and approval waiting. Explains {id,chatId,status,reason,origin}; queued/running is admission, not completion. Reads a later snapshot through core.ai.chat.run.read on the same chat with {id} and unwraps its Query data, without polling for human approval. Keeps Action replies direct and Query mock data unwrapped, with optional page beside ok. If the handler retries, tests same-key recovery and changed-input conflict within one entrypoint invocation. Uses separate fixtures for independent Code runs: fixture runs share fake receipts and do not prove cross-run deduplication. Never adds duplicate starts just to pass a test. Checks DST boundaries without a fixed UTC-offset approximation or live agent calls.",
      "Explains normal owner Assistant allowance and actual-usage accounting in existing Code and Code-owner daily USD limits; starting a turn does not debit the full Code attempt allowance.",
      "If local cron timezone support or core.ai.chat.run is missing, names the precise dependency and retains an inactive draft. This is a blocked evaluation, never a successful-submission pass.",
    ],
  },
] as const;

/** Normalize captured Gustav calls without removing error information. Never execute an imported trace. */
export const AutomationRebuildTraceSchema = z.object({
  calls: z.array(z.object({ name: z.string(), args: z.json(), result: z.json(), isError: z.boolean().optional() })),
  answer: z.string().min(1),
});
export type AutomationRebuildTrace = z.infer<typeof AutomationRebuildTraceSchema>;
const object = z.record(z.string(), z.json());
const source = z.object({ codeId: z.string(), files: z.record(z.string(), z.string()), entry: z.string().default("code.ts") });
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
const succeeded = (call: AutomationRebuildTrace["calls"][number]) => {
  const parsed = object.safeParse(call.result);
  return !call.isError && parsed.success && !("error" in parsed.data && parsed.data.error !== null) && parsed.data.ok !== false;
};

/** Mechanical evidence only. The case rubric still requires a person to compare behavior and SDK semantics. */
export function scoreAutomationRebuild(trace: AutomationRebuildTrace) {
  const failures: string[] = [];
  if (
    trace.calls.some(
      (call) =>
        !/^(code_(init|pull|read|sdk|write|check|test|simulate|submit|diff)|load_(tools|skill)|todo_write|survey|search_(tools|skills|help)|read_(file|help)|list_(files|apps))$/.test(
          call.name,
        ),
    )
  )
    failures.push("Unexpected tool: review for activation, grants or live effects.");
  const submitIndex = trace.calls.findLastIndex((call) => call.name === "code_submit");
  const submit = trace.calls[submitIndex];
  const submitted = source.safeParse(submit?.args);
  if (!submit || !submitted.success || !succeeded(submit) || !object.safeParse(submit.result).data?.submission)
    return { mechanicalPassed: false, failures: [...failures, "No successful candidate submission."], semanticReviewRequired: true };
  const before = trace.calls.slice(0, submitIndex);
  const sameSource = (call: AutomationRebuildTrace["calls"][number]) => {
    const parsed = source.safeParse(call.args);
    return parsed.success && stable(parsed.data) === stable(submitted.data);
  };
  const checked = before.findLastIndex(
    (call) =>
      call.name === "code_check" &&
      sameSource(call) &&
      succeeded(call) &&
      object.safeParse(object.safeParse(call.result).data?.result).data?.ok === true,
  );
  const tested = before.findLastIndex(
    (call) => call.name === "code_test" && sameSource(call) && succeeded(call) && object.safeParse(call.result).data?.ok === true,
  );
  const init = before.findLastIndex(
    (call) =>
      (call.name === "code_init" || call.name === "code_pull" || call.name === "code_read") &&
      object.safeParse(object.safeParse(call.result).data?.config).data?.codeId === submitted.data.codeId &&
      succeeded(call),
  );
  const sdk = before.findIndex(
    (call) => call.name === "code_sdk" && object.safeParse(call.args).data?.codeId === submitted.data.codeId && succeeded(call),
  );
  const write = before.findIndex((call) => call.name === "code_write" && succeeded(call));
  if (!(init >= 0 && sdk > init && write > sdk && checked > write && tested > checked))
    failures.push("Need init/pull → sdk → write → successful check → successful test → submit for the submitted source.");
  const initialized = object.safeParse(before[init]?.result).data;
  const config = object.safeParse(initialized?.config).data;
  const submitArgs = object.parse(submit.args);
  if (!config || config.codeId !== submitted.data.codeId || config.baseVersionId !== submitArgs.baseVersionId)
    failures.push("Submitted project/base differs from init/pull.");
  const tests = z.record(z.string(), z.string()).safeParse(submitArgs.tests);
  const testedArgs = object.safeParse(before[tested]?.args).data;
  if (!tests.success || Object.keys(tests.data).length === 0 || stable(tests.data) !== stable(testedArgs?.tests))
    failures.push("Submit must retain the same nonempty fictional tests that passed.");
  if (tests.success)
    for (const [path, content] of Object.entries(tests.data)) {
      try {
        const fixture = CodeTestCaseSchema.parse(JSON.parse(content));
        if (!/^test\/.+\.json$/.test(path) || fixture.runs.some((run) => !run.expect || Object.keys(run.expect).length === 0))
          throw new Error("Missing assertions");
      } catch {
        failures.push(`Invalid fixed-clock/seed fixture or missing assertions: ${path}`);
      }
    }
  return { mechanicalPassed: failures.length === 0, failures, semanticReviewRequired: true };
}
