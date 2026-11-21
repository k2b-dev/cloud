import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AiWakeupSchema } from "@k2b/cloud/ai";
import { z } from "zod";
import { CHAT_ALARM_CASES, type ChatAlarmTrace, scoreChatAlarm } from "./chat-alarms";

afterEach(() => setSystemTime());

const byName = (name: (typeof CHAT_ALARM_CASES)[number]["name"]) => CHAT_ALARM_CASES.find((item) => item.name === name)!;
const list = (name: Parameters<typeof byName>[0]): ChatAlarmTrace["calls"][number] => ({
  name: "wakeup_list",
  args: {},
  result: z.json().parse({ items: byName(name).alarms, limit: 5, paused: false }),
});
const done = (calls: ChatAlarmTrace["calls"]): ChatAlarmTrace => ({ calls, answer: "Erledigt." });
const passing = (verdict: ReturnType<typeof scoreChatAlarm>) =>
  expect(verdict).toEqual({ mechanicalPassed: true, failures: [], semanticReviewRequired: true });

test("ships set, postpone and delete cases with alarm fixtures that match the public alarm schema", () => {
  expect(CHAT_ALARM_CASES.map((item) => item.name)).toEqual([
    "set-once",
    "set-repeating",
    "move-by-sentence",
    "postpone-in-alarm-turn",
    "postpone-limit",
    "delete",
    "limit-reached",
    "automation-instead",
  ]);
  for (const item of CHAT_ALARM_CASES) {
    expect(Number.isNaN(Date.parse(item.now))).toBeFalse();
    for (const alarm of item.alarms) expect<unknown>(AiWakeupSchema.parse(alarm)).toEqual(alarm);
  }
  // F3 A: five alarms per chat; the snooze case starts at the third and last postponement.
  expect(byName("limit-reached").alarms).toHaveLength(5);
  expect(new Set(byName("limit-reached").alarms.map((alarm) => alarm.id)).size).toBe(5);
  expect(byName("postpone-limit").alarms[0]?.snoozes).toBe(3);
});

test("scores with the case clock, not the scorer's clock", () => {
  // A later real day would make 16:00 look past; the case clock keeps the verdict stable.
  setSystemTime(new Date("2031-03-30T02:30:00+02:00"));
  const at = "2026-11-19T15:00:00Z";
  passing(
    scoreChatAlarm(
      byName("set-once"),
      done([
        {
          name: "wakeup_create",
          args: { at, timezone: "Europe/Berlin", note: "Prüfe, ob Lena Vogt auf A-2041 geantwortet hat." },
          result: { id: "x" },
        },
      ]),
    ),
  );
  const postpone = byName("postpone-in-alarm-turn");
  passing(
    scoreChatAlarm(
      postpone,
      done([
        list("postpone-in-alarm-turn"),
        { name: "wakeup_update", args: { id: postpone.alarms[0]!.id, revision: 2, at: "2026-11-20T09:00:00+01:00" }, result: {} },
      ]),
    ),
  );
});

test("accepts a repeating alarm, a move by sentence and a delete with the listed revision", () => {
  passing(
    scoreChatAlarm(
      byName("set-repeating"),
      done([
        {
          name: "wakeup_create",
          args: { cron: "0 8 * * 1-5", timezone: "Europe/Berlin", note: "Frag nach der wichtigsten Aufgabe." },
          result: {},
        },
      ]),
    ),
  );
  // The backend accepts the first occurrence as `at` beside cron, and named weekdays.
  passing(
    scoreChatAlarm(
      byName("set-repeating"),
      done([
        {
          name: "wakeup_create",
          args: { cron: "0 8 * * MON-FRI", at: "2026-11-20T07:00:00Z", timezone: "Europe/Berlin", note: "Frag nach der Aufgabe." },
          result: {},
        },
      ]),
    ),
  );
  const wrongRepeats: Record<string, string>[] = [
    { cron: "0 8 * * *", timezone: "Europe/Berlin", note: "Täglich" },
    { cron: "0 8 * * 1-5", at: "2026-11-23T08:00:00+01:00", timezone: "Europe/Berlin", note: "Später" },
  ];
  for (const args of wrongRepeats)
    expect(scoreChatAlarm(byName("set-repeating"), done([{ name: "wakeup_create", args, result: {} }])).mechanicalPassed).toBeFalse();
  const lena = byName("move-by-sentence").alarms[0]!;
  passing(
    scoreChatAlarm(
      byName("move-by-sentence"),
      done([
        list("move-by-sentence"),
        { name: "wakeup_update", args: { id: lena.id, revision: 2, at: "2026-11-19T17:00:00+01:00" }, result: {} },
      ]),
    ),
  );
  passing(
    scoreChatAlarm(byName("delete"), done([list("delete"), { name: "wakeup_delete", args: { id: lena.id, revision: 2 }, result: {} }])),
  );
});

test("rejects a wrong time, zone, alarm, stale revision or a second alarm", () => {
  const once = byName("set-once");
  const create = (args: Record<string, string>) => ({
    name: "wakeup_create",
    args: { timezone: "Europe/Berlin", note: "Lena?", ...args },
    result: {},
  });
  expect(scoreChatAlarm(once, done([create({ at: "2026-11-19T16:00:00Z" })])).mechanicalPassed).toBeFalse();
  expect(scoreChatAlarm(once, done([create({ at: "2026-11-19T16:00:00+01:00", timezone: "UTC" })])).mechanicalPassed).toBeFalse();
  expect(
    scoreChatAlarm(once, done([create({ at: "2026-11-19T16:00:00+01:00" }), create({ at: "2026-11-19T16:30:00+01:00" })])).mechanicalPassed,
  ).toBeFalse();
  const move = byName("move-by-sentence");
  const [lena, report] = move.alarms;
  const update = (id: string, revision: number, at = "2026-11-19T17:00:00+01:00") => ({
    name: "wakeup_update",
    args: { id, revision, at },
    result: {},
  });
  for (const calls of [
    [list("move-by-sentence"), update(report!.id, 1)],
    [list("move-by-sentence"), update(lena!.id, 1)],
    [update(lena!.id, 2)],
    [list("move-by-sentence"), update(lena!.id, 2, "2026-11-19T18:00:00+01:00")],
    [list("move-by-sentence"), create({ at: "2026-11-19T17:00:00+01:00" })],
  ])
    expect(scoreChatAlarm(move, done(calls)).mechanicalPassed).toBeFalse();
});

test("an alarm turn creates nothing, changes only the time, and stops after three postponements", () => {
  const turn = byName("postpone-in-alarm-turn");
  const id = turn.alarms[0]!.id;
  const later = "2026-11-19T18:00:00+01:00";
  for (const calls of [
    [list("postpone-in-alarm-turn"), { name: "wakeup_update", args: { id, revision: 2, at: later, note: "Neu" }, result: {} }],
    [list("postpone-in-alarm-turn"), { name: "wakeup_update", args: { id, revision: 2, at: "2026-11-19T15:00:00+01:00" }, result: {} }],
  ])
    expect(scoreChatAlarm(turn, done(calls)).mechanicalPassed).toBeFalse();
  // A valid postponement still fails when the turn also tried to create an alarm, even a refused one.
  const valid = [list("postpone-in-alarm-turn"), { name: "wakeup_update", args: { id, revision: 2, at: later }, result: {} }];
  passing(scoreChatAlarm(turn, done(valid)));
  const refused = {
    name: "wakeup_create",
    args: { at: later, timezone: "Europe/Berlin", note: "Lena?" },
    result: "An alarm turn cannot create another alarm.",
    isError: true,
  };
  expect(scoreChatAlarm(turn, done([...valid, refused])).failures).toEqual(["Tried to create an alarm in an alarm turn."]);
  const limit = byName("postpone-limit");
  passing(scoreChatAlarm(limit, done([list("postpone-limit")])));
  expect(
    scoreChatAlarm(limit, done([list("postpone-limit"), { name: "wakeup_update", args: { id, revision: 5, at: later }, result: {} }]))
      .mechanicalPassed,
  ).toBeFalse();
});

test("a refused create at the limit passes; Code for a reminder fails; an event request may lead to Code", () => {
  const full = byName("limit-reached");
  const tomorrow = { at: "2026-11-20T14:00:00+01:00", timezone: "Europe/Berlin", note: "Zahnarzt." };
  passing(
    scoreChatAlarm(
      full,
      done([
        { name: "wakeup_create", args: tomorrow, result: "This chat already has five alarms. Change or delete one first.", isError: true },
      ]),
    ),
  );
  for (const name of ["code_init", "code_pull", "code_write"])
    expect(scoreChatAlarm(full, done([{ name, args: {}, result: {} }])).failures).toEqual(["Started Code authoring instead of an alarm."]);
  const event = byName("automation-instead");
  passing(
    scoreChatAlarm(
      event,
      done([
        { name: "load_skill", args: { name: "code-authoring" }, result: {} },
        { name: "code_write", args: {}, result: {} },
      ]),
    ),
  );
  expect(scoreChatAlarm(event, done([{ name: "wakeup_create", args: tomorrow, result: {} }])).mechanicalPassed).toBeFalse();
});
