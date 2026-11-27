import { logFixtureId, logFixtureItems } from "./_components/mail-rule-history-fixtures";
import type { MailCodeHistoryData } from "./MailCodeHistory";

/** The states the history step is shown and tested in. */
export const MAIL_CODE_HISTORY_STATES = ["tag", "eintrag", "leer", "lauf"] as const;
export type MailCodeHistoryState = (typeof MAIL_CODE_HISTORY_STATES)[number];

const runs = [
  { id: logFixtureId(901), createdAt: "2026-10-26T07:58:00.000Z", name: "Mails nach Art verteilen", state: "completed", snapshot: null },
  { id: logFixtureId(902), createdAt: "2026-10-26T08:41:00.000Z", name: "Rechnungen an die Buchhaltung", state: "failed", snapshot: null },
];

/** Invented data of the mailbox "Vertrieb": one day of the retired rules' log and two earlier runs. */
export const mailCodeHistoryFixture = (state: MailCodeHistoryState): MailCodeHistoryData => ({
  codeHref: "/app/mail/Mb4kd2/code",
  day: "2026-10-26",
  items: state === "leer" ? [] : logFixtureItems,
  nextCursor: state === "tag" ? "older-entries-cursor" : null,
  entry: state === "eintrag" ? logFixtureItems[3]!.id : null,
  runs: { items: runs, nextCursor: null },
  run:
    state === "lauf"
      ? {
          ...runs[1]!,
          snapshot: { run: { state: "failed" }, sourceName: runs[1]!.name, steps: [{ step_key: "assign" }, { step_key: "move" }] },
        }
      : null,
});
