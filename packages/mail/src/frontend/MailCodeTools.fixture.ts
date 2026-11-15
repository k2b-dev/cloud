import type { MailCodeCatchUpData, MailCodeCatchUpStatus, MailCodeSelection } from "./MailCodeTools";

/** Every step of "Process existing mail" as the server renders it; the names follow the approved mockup. */
export const MAIL_CODE_CATCH_UP_STATES = [
  "auswahl",
  "vorschau",
  "vorschau-mehr",
  "vorschau-leer",
  "laeuft",
  "angehalten",
  "teilfehler",
  "veraltet",
  "veraltet-teilweise",
  "fertig",
  "lese-fehler",
  "vorschau-fehler",
  "pausiert",
  "nur-lesen",
] as const;
export type MailCodeCatchUpFixtureState = (typeof MAIL_CODE_CATCH_UP_STATES)[number];

const VERSION_4 = "00000000-0000-4000-8000-000000000004";
const VERSION_5 = "00000000-0000-4000-8000-000000000005";
const OPERATION = "00000000-0000-4000-8000-0000000000aa";
const time = (day: number) => `2026-11-${String(day).padStart(2, "0")}T08:${String(day).padStart(2, "0")}:00.000Z`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Fictional subjects of delivery notices, as a mail client shows them. */
const subjects = ["Lieferavis Polsterei Weber", "Lieferavis Stoffe Nord", "Lieferavis Beschläge Kern", "Lieferavis Holz Brandt"];
/** Twelve delivery notices in the Möbel Beispiel mailbox, oldest first. */
const selection = (count: number, more = false): MailCodeSelection => ({
  cutoffAt: "2026-11-14T09:00:00.000Z",
  items: Array.from({ length: count }, (_, index) => ({
    title: subjects[index % subjects.length]!,
    event: {
      id: id(100 + index),
      type: "mail.message.received",
      version: 1,
      source: "mail",
      time: time(index + 1),
      subject: { type: "mail.message", id: `Msg${String(index + 1).padStart(3, "0")}` },
      place: { type: "mail.mailbox", id: "Mb4kd2" },
      data: { receiptId: id(200 + index) },
    },
  })),
  nextCursor: more ? { date: time(count), id: id(100 + count - 1) } : null,
});
const status = (overrides: Partial<MailCodeCatchUpStatus>): MailCodeCatchUpStatus => ({
  operationId: OPERATION,
  versionId: VERSION_4,
  status: "running",
  total: 12,
  dispatched: 7,
  failureCount: 0,
  lastError: null,
  createdAt: "2026-11-14T09:00:00.000Z",
  updatedAt: "2026-11-14T09:01:00.000Z",
  ...overrides,
});

export const mailCodeCatchUpFixture = (state: MailCodeCatchUpFixtureState, locale: "de" | "en"): MailCodeCatchUpData => {
  const base: MailCodeCatchUpData = {
    mailboxId: "Mb4kd2",
    codeHref: "/app/mail/Mb4kd2/code",
    blocked: null,
    codeId: "c_mail0001",
    version: { id: VERSION_4, number: 4 },
    folders: [
      { id: "Fold01", name: locale === "de" ? "Posteingang" : "Inbox" },
      { id: "Fold04", name: locale === "de" ? "Archiv" : "Archive" },
    ],
    pick: { folder: null, from: "2026-11-01", to: "2026-11-13" },
    page: null,
    previewVersionId: null,
    selection: null,
    selectionFailed: false,
    operationId: null,
    operation: null,
    operationFailed: false,
    operationVersion: null,
    next: null,
    stale: null,
  };
  const operation = (overrides: Partial<MailCodeCatchUpStatus>) => ({
    ...base,
    operationId: OPERATION,
    operation: status(overrides),
    operationVersion: 4,
  });
  switch (state) {
    case "auswahl":
      return base;
    case "vorschau":
      return { ...base, previewVersionId: VERSION_4, selection: selection(12) };
    case "vorschau-mehr":
      return { ...base, previewVersionId: VERSION_4, selection: selection(100, true) };
    case "vorschau-leer":
      return { ...base, previewVersionId: VERSION_4, selection: selection(0) };
    case "laeuft":
      return operation({ status: "running" });
    case "angehalten":
      return operation({ status: "canceled" });
    case "teilfehler":
      return operation({
        status: "failed",
        dispatched: 10,
        failureCount: 3,
        lastError: "The handler's resource access is unavailable.",
      });
    case "veraltet":
      return { ...base, version: { id: VERSION_5, number: 5 }, stale: { version: 5, done: 0, old: null } };
    case "veraltet-teilweise":
      return {
        ...operation({ status: "failed", versionId: VERSION_4, lastError: "Catch-up version is no longer active." }),
        version: { id: VERSION_5, number: 5 },
        stale: { version: 5, done: 7, old: 4 },
      };
    case "fertig":
      return operation({ status: "completed", dispatched: 12 });
    case "lese-fehler":
      return { ...base, operationId: OPERATION, operationFailed: true };
    case "vorschau-fehler":
      return { ...base, selectionFailed: true };
    case "pausiert":
      return { ...base, blocked: "paused", codeId: null, version: null };
    case "nur-lesen":
      return { ...base, blocked: "reader", codeId: null, version: null };
  }
};
