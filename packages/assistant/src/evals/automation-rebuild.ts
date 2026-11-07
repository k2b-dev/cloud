import { CodeTestCaseSchema } from "@k2b/cloud/code";
import { z } from "zod";
import mail from "./fixtures/mail-rule-v1.json";
import routine from "./fixtures/routine-v1.json";

/** Copies of the v1 export format, kept here until the main export PR is synced. No legacy service dependency. */
export const AUTOMATION_REBUILD_CASES = [
  {
    name: "mail-rule",
    export: mail,
    request:
      "Explain this exported rule and draft its equivalent as mailbox-owned Code. Keep it inactive. Use the supplied fictional mailbox only in fictional tests; discover its real replacement before submission.",
    review: [
      "Explains disabled source, priority 7/order 1, chosen current version, sender filter and message-level keyword effect.",
      "Uses discovered app.on/mail.message.received and Mail message read/keyword operations; no polling or conversation-wide substitute.",
      "Covers matching and nonmatching arrivals, action refusal and repeat delivery with the same logical effect key.",
    ],
  },
  {
    name: "routine",
    export: routine,
    request:
      "Explain this exported routine and draft its equivalent as personal Code. I explicitly choose a NEW general Chat conversation as delivery target instead of the original Assistant chat. Discover and let me select that target; do not guess an ID. Preserve the one-time UTC instant and keep it inactive.",
    review: [
      "Explains prompt, paused state, one-time instant/timezone, empty grants and original Assistant target.",
      "Uses app.schedule, discovered core.ai.generate and Chat delivery; calls out the explicitly requested target change.",
      "Tests fixed-time generation, provider refusal, Chat refusal and retry without duplicate delivery; no live calls.",
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
        !/^(code_(init|sdk|write|check|test|submit|diff)|load_[a-z_]+|read_skill_reference|discover_[a-z_]+|todo_write|survey|search_tools|read_file|list_files)$/.test(
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
  const init = before.findIndex((call) => call.name === "code_init" && succeeded(call));
  const sdk = before.findIndex(
    (call) => call.name === "code_sdk" && object.safeParse(call.args).data?.codeId === submitted.data.codeId && succeeded(call),
  );
  const write = before.findIndex((call) => call.name === "code_write" && succeeded(call));
  if (!(init >= 0 && sdk > init && write > sdk && checked > write && tested > checked))
    failures.push("Need init → sdk → write → successful check → successful test → submit for the submitted source.");
  const initialized = object.safeParse(before[init]?.result).data;
  const config = object.safeParse(initialized?.config).data;
  const submitArgs = object.parse(submit.args);
  if (!config || config.codeId !== submitted.data.codeId || config.baseVersionId !== submitArgs.baseVersionId)
    failures.push("Submitted project/base differs from init.");
  const tests = z.record(z.string(), z.string()).safeParse(submitArgs.tests);
  const testedArgs = object.safeParse(before[tested]?.args).data;
  if (!tests.success || Object.keys(tests.data).length === 0 || stable(tests.data) !== stable(testedArgs?.tests))
    failures.push("Submit must retain the same nonempty fictional tests that passed.");
  if (tests.success)
    for (const [path, content] of Object.entries(tests.data)) {
      try {
        const fixture = CodeTestCaseSchema.parse(JSON.parse(content));
        if (!/^test\/.+\.json$/.test(path) || fixture.runs.some((run) => !run.expect)) throw new Error("Missing assertions");
      } catch {
        failures.push(`Invalid fixed-clock/seed fixture or missing assertions: ${path}`);
      }
    }
  return { mechanicalPassed: failures.length === 0, failures, semanticReviewRequired: true };
}
