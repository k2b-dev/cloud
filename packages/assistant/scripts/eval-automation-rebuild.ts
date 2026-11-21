import { parseArgs } from "node:util";
import { AUTOMATION_REBUILD_CASES, AutomationRebuildTraceSchema, scoreAutomationRebuild } from "../src/evals/automation-rebuild";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { help: { type: "boolean" }, case: { type: "string" }, trace: { type: "string" } },
});
if (values.help) {
  console.log(`Usage: bun packages/assistant/scripts/eval-automation-rebuild.ts --case <mail-rule|routine|routine-agent> [--trace <file>]

Without --trace, prints the fictional export, Gustav request and human review rubric.
Run the request in an isolated Gustav evaluation chat, capture tool calls and answer
as {calls:[{name,args,result,isError?}],answer}, then score with --trace.
Results must be decoded tool JSON (no transport wrapper); preserve failures.
Scoring is offline and makes no calls, activates nothing and grants no access.
A mechanical pass requires human semantic review; it does not prove equivalence.`);
} else {
  const item = AUTOMATION_REBUILD_CASES.find((item) => item.name === values.case);
  if (!item) throw new Error("Choose --case mail-rule, routine or routine-agent (see --help).");
  if (!values.trace) console.log(JSON.stringify(item, null, 2));
  else {
    const score = scoreAutomationRebuild(AutomationRebuildTraceSchema.parse(await Bun.file(values.trace).json()));
    console.log(JSON.stringify({ case: item.name, ...score, review: item.review }, null, 2));
    if (!score.mechanicalPassed) process.exitCode = 1;
  }
}
