import { parseArgs } from "node:util";
import { CHAT_ALARM_CASES, ChatAlarmTraceSchema, scoreChatAlarm } from "../src/evals/chat-alarms";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { help: { type: "boolean" }, case: { type: "string" }, trace: { type: "string" } },
});
const names = CHAT_ALARM_CASES.map((item) => item.name).join("|");
if (values.help) {
  console.log(`Usage: bun packages/assistant/scripts/eval-chat-alarms.ts --case <${names}> [--trace <file>]

Without --trace, prints the case clock, time zone, trigger, existing alarms, request and review rubric.
Run the request in an isolated Gustav evaluation chat at that clock, capture tool calls and answer
as {calls:[{name,args,result,isError?}],answer}, then score with --trace.
Results must be decoded tool JSON (no transport wrapper); preserve failures.
Scoring is offline, makes no calls and uses the case clock. A mechanical pass still needs human review.`);
} else {
  const item = CHAT_ALARM_CASES.find((item) => item.name === values.case);
  if (!item) throw new Error(`Choose --case ${names} (see --help).`);
  if (!values.trace) console.log(JSON.stringify(item, null, 2));
  else {
    const score = scoreChatAlarm(item, ChatAlarmTraceSchema.parse(await Bun.file(values.trace).json()));
    console.log(JSON.stringify({ case: item.name, ...score, review: item.review }, null, 2));
    if (!score.mechanicalPassed) process.exitCode = 1;
  }
}
