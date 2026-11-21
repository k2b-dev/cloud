import { type AiWakeup, AiWakeupInputSchema, AiWakeupPatchSchema } from "@k2b/cloud/ai";
import { z } from "zod";

const OWNER = "5d4a6c1e-8b2f-4c3a-9e7d-1f0b2a3c4d5e";
const LENA = "0b8c6f2a-4d1e-4f3b-8a9c-2e7d5b1a6c40";
const REPORT = "7e3f1a9b-2c4d-4e5f-8a6b-9c0d1e2f3a4b";
const TIMEZONE = "Europe/Berlin";

const alarm = (id: string, patch: Partial<AiWakeup>): AiWakeup => ({
  id,
  at: null,
  cron: null,
  timezone: TIMEZONE,
  endsAt: null,
  note: "",
  noteSource: { kind: "person", userId: OWNER },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 1,
  rhythm: "Once",
  ...patch,
});

const lena = alarm(LENA, {
  at: "2026-11-19T16:00:00+01:00",
  note: "Prüfe, ob Lena Vogt auf das Angebot A-2041 geantwortet hat.",
  revision: 2,
  rhythm: "Einmalig",
});
const report = alarm(REPORT, {
  at: "2026-11-20T08:00:00+01:00",
  cron: "0 8 * * 5",
  endsAt: "2026-12-19T10:00:00+01:00",
  note: "Wochenbericht schreiben.",
  rhythm: "Freitags um 08:00",
});

/** What a fully passing trace must show. Everything else is the person's rubric review. */
type AlarmExpectation =
  | { kind: "create"; at: string; crons?: never; firstAt?: never; timezone: string }
  /** Accepted spellings of the same repeat; `firstAt` is the first occurrence Gustav may pass as `at`. */
  | { kind: "create"; crons: readonly string[]; firstAt: string; at?: never; timezone: string }
  | { kind: "postpone"; id: string; at?: string }
  | { kind: "delete"; id: string }
  | { kind: "no-change" };

type AlarmCase = {
  name: string;
  /** Fixed clock of the evaluation chat; set the evaluation installation to this instant. */
  now: string;
  timezone: string;
  trigger: "person" | "wakeup";
  /** The chat's alarms before the request, as `wakeup_list` returns them. */
  alarms: readonly AiWakeup[];
  request: string;
  expect: AlarmExpectation;
  /** Only a request beyond the alarm limits may lead to Code authoring. */
  codeAllowed?: boolean;
  review: readonly string[];
};

/** Gustav alarms v1 (concept 16.11.2026, F2 A, F3 A, F4 A): set, postpone and delete in the person's own chat. */
export const CHAT_ALARM_CASES = [
  {
    name: "set-once",
    now: "2026-11-19T10:00:00+01:00",
    timezone: TIMEZONE,
    trigger: "person",
    alarms: [],
    request: "Schau heute um 16:00 nach, ob Lena Vogt auf das Angebot A-2041 geantwortet hat.",
    expect: { kind: "create", at: "2026-11-19T16:00:00+01:00", timezone: TIMEZONE },
    review: [
      "Sets one alarm with wakeup_create, without Code and without asking for an approval.",
      'The note is a short task in the imperative in German with Lena Vogt and A-2041, such as "Antwort von Lena Vogt auf A-2041 prüfen"; it never names the person or says "Erinnere mich"/"Remind Lea"; at most 200 characters.',
      "Confirms in one sentence with 16:00 and the note; shows no cron, ID or revision.",
    ],
  },
  {
    name: "set-repeating",
    now: "2026-11-19T10:00:00+01:00",
    timezone: TIMEZONE,
    trigger: "person",
    alarms: [],
    request: "Frag mich jeden Werktag um 8 Uhr nach meiner wichtigsten Aufgabe.",
    expect: { kind: "create", crons: ["0 8 * * 1-5", "0 8 * * mon-fri"], firstAt: "2026-11-20T08:00:00+01:00", timezone: TIMEZONE },
    review: [
      "Sets one repeating alarm with cron and Europe/Berlin; no Code automation.",
      'The note is a short task in the imperative, such as "Nach der wichtigsten Aufgabe fragen"; it never names the person.',
      "Says in words that it runs on weekdays at 08:00 and ends after 30 days unless renewed; uses the returned rhythm, never cron.",
    ],
  },
  {
    name: "move-by-sentence",
    now: "2026-11-19T11:00:00+01:00",
    timezone: TIMEZONE,
    trigger: "person",
    alarms: [lena, report],
    request: "Verschieb den Wecker für Lena auf 17 Uhr.",
    expect: { kind: "postpone", id: LENA, at: "2026-11-19T17:00:00+01:00" },
    review: [
      "Lists alarms, then changes the same Lena alarm to 17:00 today with its current revision; creates no second alarm.",
      "Leaves the weekly report alarm unchanged and confirms the new time in one sentence.",
    ],
  },
  {
    name: "postpone-in-alarm-turn",
    now: "2026-11-19T16:01:00+01:00",
    timezone: TIMEZONE,
    trigger: "wakeup",
    alarms: [lena],
    request: "Alarm turn of the Lena alarm (planned 16:00, postponements 0/3). The fictional mailbox has no reply from Lena Vogt yet.",
    expect: { kind: "postpone", id: LENA },
    review: [
      "Checks for the reply first with the current permissions and says that none has arrived.",
      "Postpones only the triggering alarm with a new at (no note, cron or end change) and names the new time; never creates an alarm.",
    ],
  },
  {
    name: "postpone-limit",
    now: "2026-11-19T16:01:00+01:00",
    timezone: TIMEZONE,
    trigger: "wakeup",
    alarms: [{ ...lena, snoozes: 3, revision: 5 }],
    request: "Alarm turn of the Lena alarm (planned 16:00, postponements 3/3). The fictional mailbox has no reply from Lena Vogt yet.",
    expect: { kind: "no-change" },
    review: [
      "Does not postpone a fourth time and creates no alarm.",
      "Tells the person that no reply has arrived and that they can set a new time themselves.",
    ],
  },
  {
    name: "delete",
    now: "2026-11-19T11:00:00+01:00",
    timezone: TIMEZONE,
    trigger: "person",
    alarms: [lena, report],
    request: "Lösch den Wecker für Lena.",
    expect: { kind: "delete", id: LENA },
    review: ["Deletes only the Lena alarm with its current revision and confirms in one sentence."],
  },
  {
    name: "limit-reached",
    now: "2026-11-19T11:00:00+01:00",
    timezone: TIMEZONE,
    trigger: "person",
    alarms: [
      lena,
      report,
      ...["1a", "2b", "3c"].map((suffix, index) =>
        alarm(`9f2e4d6c-8b0a-4c1e-9d3f-5a7b9c1d3e${suffix}`, {
          at: `2026-11-2${index + 1}T09:00:00+01:00`,
          note: `Fiktiver Wecker ${index + 1}.`,
          rhythm: "Einmalig",
        }),
      ),
    ],
    request: "Erinnere mich morgen um 14 Uhr an den Zahnarzt.",
    expect: { kind: "no-change" },
    review: [
      "Sets no alarm and explains the five-alarm limit; a refused wakeup_create attempt is acceptable.",
      "Offers to change or delete one of the listed alarms; does not substitute Code.",
    ],
  },
  {
    name: "automation-instead",
    now: "2026-11-19T11:00:00+01:00",
    timezone: TIMEZONE,
    trigger: "person",
    alarms: [],
    request: "Sag mir jedes Mal Bescheid, wenn eine Mail von der Polsterei Weber kommt.",
    expect: { kind: "no-change" },
    codeAllowed: true,
    review: [
      "Sets no alarm because the request reacts to an event, not to a time.",
      "Proposes a Code automation and loads code-authoring before drafting anything; activates nothing.",
    ],
  },
] as const satisfies readonly AlarmCase[];

export const ChatAlarmTraceSchema = z.object({
  calls: z.array(z.object({ name: z.string(), args: z.json(), result: z.json(), isError: z.boolean().optional() })),
  answer: z.string().min(1),
});
export type ChatAlarmTrace = z.infer<typeof ChatAlarmTraceSchema>;
type Call = ChatAlarmTrace["calls"][number];

const object = z.record(z.string(), z.json());
const MUTATIONS = new Set(["wakeup_create", "wakeup_update", "wakeup_delete"]);
const succeeded = (call: Call) => {
  const parsed = object.safeParse(call.result);
  return !call.isError && parsed.success && !("error" in parsed.data && parsed.data.error !== null) && parsed.data.ok !== false;
};
const listed = z.object({ items: z.array(z.object({ id: z.string(), revision: z.number() })) });
const UpdateSchema = AiWakeupPatchSchema.safeExtend({ id: z.uuid() });
const DeleteSchema = z.strictObject({ id: z.uuid(), revision: z.number().int().nonnegative() });

/** Mechanical evidence only, with the case clock instead of the scorer's clock. The rubric still needs a person. */
export function scoreChatAlarm(item: AlarmCase, trace: ChatAlarmTrace) {
  const failures: string[] = [];
  const now = Date.parse(item.now);
  if (!item.codeAllowed && trace.calls.some((call) => call.name.startsWith("code_")))
    failures.push("Started Code authoring instead of an alarm.");
  if (item.trigger === "wakeup" && trace.calls.some((call) => call.name === "wakeup_create"))
    failures.push("Tried to create an alarm in an alarm turn.");
  const changes = trace.calls.flatMap((call, index) => (MUTATIONS.has(call.name) && succeeded(call) ? [{ call, index }] : []));
  const expected = item.expect;
  if (expected.kind === "no-change") {
    if (changes.length > 0) failures.push("Changed alarms although the case expects no change.");
    return { mechanicalPassed: failures.length === 0, failures, semanticReviewRequired: true };
  }
  const name = { create: "wakeup_create", postpone: "wakeup_update", delete: "wakeup_delete" }[expected.kind];
  if (changes.length !== 1 || changes[0]!.call.name !== name) {
    failures.push(`Need exactly one successful ${name} and no other alarm change.`);
    return { mechanicalPassed: false, failures, semanticReviewRequired: true };
  }
  const { call, index } = changes[0]!;
  if (expected.kind === "create") {
    const input = AiWakeupInputSchema.safeParse(call.args);
    if (!input.success) failures.push("wakeup_create input does not match the alarm schema.");
    else {
      if (input.data.timezone !== expected.timezone) failures.push(`Use the person's time zone ${expected.timezone}.`);
      if (
        expected.at !== undefined &&
        (input.data.at === undefined || Date.parse(input.data.at) !== Date.parse(expected.at) || input.data.cron)
      )
        failures.push(`Set one time at ${expected.at}.`);
      if (
        expected.crons !== undefined &&
        (!expected.crons.includes(input.data.cron?.trim().replace(/\s+/g, " ").toLowerCase() ?? "") ||
          (input.data.at !== undefined && Date.parse(input.data.at) !== Date.parse(expected.firstAt)))
      )
        failures.push(`Repeat with cron ${expected.crons[0]}.`);
    }
    return { mechanicalPassed: failures.length === 0, failures, semanticReviewRequired: true };
  }
  const input = (expected.kind === "postpone" ? UpdateSchema : DeleteSchema).safeParse(call.args);
  if (!input.success || input.data.id !== expected.id) {
    failures.push(`${name} must target alarm ${expected.id} with a valid input.`);
    return { mechanicalPassed: false, failures, semanticReviewRequired: true };
  }
  // The current revision comes from the latest successful list before the change, never from memory.
  const list = trace.calls
    .slice(0, index)
    .findLast((candidate) => candidate.name === "wakeup_list" && succeeded(candidate) && listed.safeParse(candidate.result).success);
  const revision = list && listed.parse(list.result).items.find((entry) => entry.id === expected.id)?.revision;
  if (revision === undefined || revision !== input.data.revision) failures.push("Use the revision from a wakeup_list before the change.");
  if (expected.kind === "postpone") {
    const patch = UpdateSchema.parse(call.args);
    const extra = Object.keys(patch).filter((key) => !["id", "revision", "at"].includes(key));
    if (item.trigger === "wakeup" && extra.length > 0) failures.push(`An alarm turn may change only at, not ${extra.join(", ")}.`);
    if (patch.at === undefined || !(Date.parse(patch.at) > now)) failures.push("Postpone to a time after the case clock.");
    else if (expected.at !== undefined && Date.parse(patch.at) !== Date.parse(expected.at))
      failures.push(`Move the alarm to ${expected.at}.`);
  }
  return { mechanicalPassed: failures.length === 0, failures, semanticReviewRequired: true };
}
