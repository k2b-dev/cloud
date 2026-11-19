import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { AiWakeup } from "@k2b/cloud/ai";
import type { AiWakeupLineInput } from "@k2b/cloud/ai/ui";
import { aiWakeupDay, aiWakeupWhen } from "../wakeup-when";
import { describeWakeupLine } from "./wakeup-line";

// Monday, 16 November 2026, 10:00 in Berlin.
beforeAll(() => setSystemTime(new Date("2026-11-16T09:00:00.000Z")));
afterAll(() => setSystemTime());

const zone = { locale: "de", timeZone: "Europe/Berlin" };
const alarm = (patch: Partial<AiWakeup> = {}): AiWakeup => ({
  id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
  at: "2026-11-16T15:00:00.000Z",
  cron: null,
  timezone: "Europe/Berlin",
  endsAt: null,
  note: "Antwort von Lena Vogt prüfen",
  noteSource: { kind: "person", userId: "6f9619ff-8b86-4d11-b42d-00c04fc96400" },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 0,
  rhythm: "Einmalig",
  ...patch,
});
const weekdays = alarm({ cron: "0 8 * * 1-5", rhythm: "Mo–Fr 08:00", endsAt: "2026-12-16T10:00:00.000Z", at: "2026-11-17T07:00:00.000Z" });
const line = (
  kind: "created" | "updated" | "deleted" | "missed" | "expired",
  wakeup: AiWakeup,
  extra: Partial<NonNullable<AiWakeupLineInput["plan"]>> = {},
): AiWakeupLineInput => ({
  plan: { event: { id: "e", kind, at: "2026-11-16T09:00:00.000Z", wakeup }, latest: true, deleted: false, ...extra },
});
const text = (value: ReturnType<typeof describeWakeupLine>) =>
  `${value.verb}${value.body}${value.aside ?? ""}${value.state ? ` ${value.state}` : ""}`;

describe("alarm times in words", () => {
  test("today and tomorrow by name, later days by date, a repeating alarm by its rhythm, never cron", () => {
    expect(aiWakeupWhen(alarm(), zone)).toBe("Heute 16:00");
    expect(aiWakeupWhen(alarm(), { ...zone, lower: true })).toBe("heute 16:00");
    expect(aiWakeupWhen(alarm(), { ...zone, short: true })).toBe("16:00");
    expect(aiWakeupWhen(alarm({ at: "2026-11-17T09:00:00.000Z" }), zone)).toBe("Morgen 10:00");
    expect(aiWakeupWhen(alarm({ at: "2026-11-19T08:00:00.000Z" }), zone)).toBe("Do., 19.11. 09:00");
    expect(aiWakeupWhen(alarm({ at: "2026-11-19T08:00:00.000Z" }), { locale: "en", timeZone: "Europe/Berlin" })).toBe("Thu, Nov 19 09:00");
    expect(aiWakeupWhen(weekdays, zone)).toBe("Mo–Fr 08:00");
    expect(aiWakeupWhen(alarm({ cron: "30 7 * * 1", rhythm: "montags 07:30" }), zone)).toBe("Montags 07:30");
    expect(aiWakeupDay("2026-12-16T10:00:00.000Z", zone)).toBe("16.12.");
  });
});

test("a repeating alarm reads in the reader's language, also when the fact stored the words of another", () => {
  const english = alarm({ cron: "0 8 * * 1", rhythm: "Mondays 08:00", endsAt: "2026-12-16T10:00:00.000Z" });
  expect(aiWakeupWhen(english, zone)).toBe("Montags 08:00");
  expect(text(describeWakeupLine(line("created", english), { ...zone, current: [english] }))).toBe(
    "Wecker · montags 08:00 · Antwort von Lena Vogt prüfen · endet 16.12.",
  );
  expect(aiWakeupWhen(alarm({ cron: "0 */2 * * *", rhythm: "Custom schedule" }), zone)).toBe("Eigener Rhythmus");
});

describe("alarm lines", () => {
  test("set: alarm, time and note; a repeating one names its end; only a current alarm has pencil and cross", () => {
    expect(text(describeWakeupLine(line("created", alarm()), { ...zone, current: [alarm()] }))).toBe(
      "Wecker · heute 16:00 · Antwort von Lena Vogt prüfen",
    );
    expect(describeWakeupLine(line("created", alarm()), { ...zone, current: [alarm()] }).acts).toEqual({
      id: alarm().id,
      edit: "Wecker ändern",
      remove: "Wecker löschen",
    });
    expect(describeWakeupLine(line("created", alarm(), { latest: false }), { ...zone, current: [alarm()] }).acts).toBeUndefined();
    expect(describeWakeupLine(line("created", alarm()), { ...zone, current: undefined }).acts).toBeUndefined();
    expect(text(describeWakeupLine(line("created", weekdays), { ...zone, current: [weekdays] }))).toBe(
      "Wecker · Mo–Fr 08:00 · Antwort von Lena Vogt prüfen · endet 16.12.",
    );
  });

  test("changed by a sentence names the time before; postponed by Gustav counts the postponements", () => {
    const later = alarm({ at: "2026-11-16T16:00:00.000Z", revision: 1 });
    expect(text(describeWakeupLine(line("updated", later, { previous: alarm() }), { ...zone, current: [later] }))).toBe(
      "Wecker · heute 17:00 · Antwort von Lena Vogt prüfen (vorher heute 16:00)",
    );
    const moved = alarm({ at: "2026-11-17T09:00:00.000Z", snoozes: 1, revision: 2 });
    expect(text(describeWakeupLine(line("updated", moved, { previous: alarm() }), { ...zone, current: [moved] }))).toBe(
      "Wecker verschoben · morgen 10:00 · Antwort von Lena Vogt prüfen (1. von 3 Verschiebungen)",
    );
  });

  test("deleted: struck through with the word, without pencil and cross", () => {
    const value = describeWakeupLine(line("created", alarm(), { deleted: true }), { ...zone, current: [] });
    expect([value.struck, value.state, value.acts, value.sign]).toEqual([true, "Gelöscht", undefined, "ti-alarm-off"]);
  });

  test("missed and expired say why in one sentence with one way out, which only the current alarm offers", () => {
    const missed = alarm({ status: "missed", missedReason: "budget" });
    const budget = describeWakeupLine(line("missed", missed), { ...zone, current: [missed] });
    expect(text(budget)).toBe(
      "Wecker heute 16:00 nicht gelaufen. Das Tageslimit für Züge ohne dich ist erreicht. Der Wecker bleibt stehen.",
    );
    expect(budget.link).toEqual({ label: "Jetzt nachholen", action: "catch-up", id: missed.id });
    expect(describeWakeupLine(line("missed", missed), { ...zone, current: [alarm()] }).link).toBeUndefined();

    const expired = { ...weekdays, status: "expired" as const };
    const ended = describeWakeupLine(line("expired", expired), { ...zone, current: [expired] });
    expect(text(ended)).toBe("Wecker abgelaufen nach 30 Tagen · Mo–Fr 08:00 · Antwort von Lena Vogt prüfen");
    expect(ended.link).toEqual({ label: "Um 30 Tage verlängern", action: "renew", id: expired.id });
    const renewed = { ...weekdays, endsAt: "2027-01-15T10:00:00.000Z", revision: 3 };
    expect(text(describeWakeupLine(line("updated", renewed, { previous: expired }), { ...zone, current: [renewed] }))).toBe(
      "Wecker verlängert · Mo–Fr 08:00 · Antwort von Lena Vogt prüfen · bis 15.01.",
    );
  });

  test("an alarm Gustav could not set offers Try again once, in both languages", () => {
    const input = { at: "2026-11-16T15:00:00.000Z", timezone: "Europe/Berlin", note: "Antwort prüfen" };
    const failed = describeWakeupLine({ failed: { input, retried: false } }, { ...zone, current: [] });
    expect([text(failed), failed.link?.label]).toEqual(["Wecker nicht gestellt · heute 16:00 · Antwort prüfen", "Erneut versuchen"]);
    expect(describeWakeupLine({ failed: { input, retried: true } }, { ...zone, current: [] }).link).toBeUndefined();
    const english = describeWakeupLine({ failed: { input, retried: false } }, { locale: "en", timeZone: "Europe/Berlin", current: [] });
    expect([text(english), english.link?.label]).toEqual(["Alarm not set · today 16:00 · Antwort prüfen", "Try again"]);
  });
});
