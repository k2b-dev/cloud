import { logFixtureId, logFixtureItems } from "./_components/mail-rule-history-fixtures";
import type { MailCodeHistoryData } from "./MailCodeHistory";

/** The states the history step is shown and tested in. */
export const MAIL_CODE_HISTORY_STATES = ["tag", "eintrag", "leer", "lauf", "fehler"] as const;
export type MailCodeHistoryState = (typeof MAIL_CODE_HISTORY_STATES)[number];

const runs = [
  { id: logFixtureId(901), createdAt: "2026-10-26T07:58:00.000Z", name: "Mails nach Art verteilen", state: "succeeded" },
  { id: logFixtureId(902), createdAt: "2026-10-26T08:41:00.000Z", name: "Rechnungen an die Buchhaltung", state: "failed" },
];

/**
 * Invented data of the mailbox "Vertrieb": one day of the retired rules' log and two earlier runs. `fehler` names a
 * day that is not a date and has runs that could not be read.
 */
export const mailCodeHistoryFixture = (state: MailCodeHistoryState): MailCodeHistoryData => ({
  codeHref: "/app/mail/Mb4kd2/code",
  day: "2026-10-26",
  dayInvalid: state === "fehler",
  today: "2026-10-27",
  before: null,
  items: state === "leer" ? [] : logFixtureItems,
  nextCursor: state === "tag" ? "older-entries-cursor" : null,
  entry: state === "eintrag" ? logFixtureItems[3]!.id : null,
  runAfter: null,
  runs: state === "fehler" ? null : { items: runs, nextCursor: null },
  run:
    state === "lauf"
      ? {
          ...runs[1]!,
          stepCount: 2,
          steps: [
            { key: "assign", state: "completed", error: null },
            { key: "move", state: "failed", error: "Den Ordner „Rechnungen 2025“ gibt es nicht mehr." },
          ],
        }
      : null,
});
