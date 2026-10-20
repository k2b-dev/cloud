import { describe, expect, test } from "bun:test";
import { approvalCard } from "../../approvals/approval-card";
import type { CapabilityActionCallReview, CapabilityPreview } from "../../contracts/capabilities";
import { reviewActionCard } from "./action-card";
import { actionCardText, actionQuestionLines } from "./action-text";

const lea = { name: "Lea Berg", address: "lea.berg@example.com" };
const ops = { name: "Team Ops", address: "ops@example.com" };
const textFor = (locale: "de" | "en", preview: CapabilityPreview, overrides: Partial<CapabilityActionCallReview> = {}) => {
  const review: CapabilityActionCallReview = {
    locale,
    slots: {},
    ask: "sends",
    sentence:
      locale === "de"
        ? { action: "Nachricht senden", running: "Wird gesendet …", done: "Gesendet.", confirm: "Senden", decline: "Nicht senden" }
        : { action: "Send message", running: "Sending …", done: "Sent.", confirm: "Send", decline: "Don't send" },
    preview,
    ...overrides,
  };
  return actionCardText(reviewActionCard(review, { locale: "en", timeZone: "Europe/Berlin", app: { name: "Mail", icon: "ti ti-mail" } }));
};
const options = {
  timeZone: "Europe/Berlin",
  commands: { approve: "cld assistant actions approve chat turn call", reject: "cld assistant actions reject chat turn call" },
};
const message: CapabilityPreview = {
  kind: "message",
  from: ops,
  to: [lea],
  cc: [ops],
  subject: "Wartungsfenster Dienstag",
  attachments: [{ name: "wartung.pdf", size: 84_000 }],
  body: "Hallo Lea,\ndas Wartungsfenster ist am Dienstag.",
  format: "plain",
};
const event: CapabilityPreview = {
  kind: "event",
  title: "Retro",
  start: "2026-10-21T16:00:00Z",
  end: "2026-10-21T18:00:00Z",
  place: "Team Ops",
  location: "Raum 2",
  attendees: [lea],
  recurrence: "weekly",
  description: "Review",
};
const rule: CapabilityPreview = {
  kind: "rule",
  when: { text: "{person} fragt", slots: { person: { kind: "person", people: [lea] } } },
  may: [
    { text: "{person} schreiben", slots: { person: { kind: "person", people: [lea] } }, mark: "added" },
    { text: "Löschen", mark: "removed" },
  ],
  does: "Zusammenfassen\nBerichten",
  seesChat: false,
};

describe("plain question blocks", () => {
  test("message in German", () => {
    const text = textFor("de", message, {
      slots: { subject: { kind: "object", title: "Wartungsfenster Dienstag" }, to: { kind: "person", people: [lea] } },
      sentence: {
        action: "Mail {subject} an {to} senden",
        running: "Mail {subject} an {to} wird gesendet …",
        done: "Mail {subject} an {to} gesendet.",
        confirm: "An {to} senden",
        decline: "Nicht senden",
      },
      links: [{ rel: "open", href: "https://cloud.example/mail/drafts/one?revision=7" }],
    });
    expect(actionQuestionLines(text, { ...options, origin: "Mail · Chat „Wartungsfenster“" })).toEqual([
      "? Mail „Wartungsfenster Dienstag“ an Lea Berg <lea.berg@example.com> senden?",
      "  Ich frage, weil das Cloud verlässt.",
      "  Mail · Chat „Wartungsfenster“",
      "  Von:     Team Ops <ops@example.com>",
      "  An:      Lea Berg <lea.berg@example.com>",
      "  Cc:      Team Ops <ops@example.com>",
      "  Betreff: Wartungsfenster Dienstag",
      "  Anhänge: wartung.pdf (84 KB)",
      "  Hallo Lea,",
      "  das Wartungsfenster ist am Dienstag.",
      "  Ganz lesen: https://cloud.example/mail/drafts/one?revision=7",
      "  An Lea Berg senden: cld assistant actions approve chat turn call",
      "  Nicht senden:       cld assistant actions reject chat turn call",
    ]);
  });
  test("message in English", () => {
    expect(actionQuestionLines(textFor("en", message), options)).toEqual([
      "? Send message?",
      "  I'm asking because this leaves Cloud.",
      "  From:        Team Ops <ops@example.com>",
      "  To:          Lea Berg <lea.berg@example.com>",
      "  Cc:          Team Ops <ops@example.com>",
      "  Subject:     Wartungsfenster Dienstag",
      "  Attachments: wartung.pdf (84 KB)",
      "  Hallo Lea,",
      "  das Wartungsfenster ist am Dienstag.",
      "  Send:       cld assistant actions approve chat turn call",
      "  Don't send: cld assistant actions reject chat turn call",
    ]);
  });
  test("event in German", () => {
    expect(actionQuestionLines(textFor("de", event), { timeZone: "Europe/Berlin" })).toEqual([
      "? Nachricht senden?",
      "  Ich frage, weil das Cloud verlässt.",
      "  Titel:        Retro",
      "  Wann:         21. Okt. 2026, 18:00",
      "  Bis:          21. Okt. 2026, 20:00",
      "  Wo:           Team Ops · Raum 2",
      "  Mit:          Lea Berg <lea.berg@example.com>",
      "  Wiederholung: weekly",
      "  Review",
    ]);
  });
  test("event in English", () => {
    expect(actionQuestionLines(textFor("en", event), { timeZone: "America/New_York" })).toEqual([
      "? Send message?",
      "  I'm asking because this leaves Cloud.",
      "  Title:   Retro",
      // Both ends stay typed, so a reader in New York reads its own times.
      "  When:    Oct 21, 2026, 12:00",
      "  Until:   Oct 21, 2026, 14:00",
      "  Where:   Team Ops · Raum 2",
      "  With:    Lea Berg <lea.berg@example.com>",
      "  Repeats: weekly",
      "  Review",
    ]);
  });
  test("rule in German", () => {
    expect(
      actionQuestionLines(
        textFor("de", rule, { consequences: [{ text: "{person} erfährt es", slots: { person: { kind: "person", people: [lea] } } }] }),
        { timeZone: "UTC" },
      ),
    ).toEqual([
      "? Nachricht senden?",
      "  Ich frage, weil das Cloud verlässt.",
      "  Startet:         Lea Berg <lea.berg@example.com> fragt",
      "  Zusammenfassen",
      "  Berichten",
      "  Darf (neu):      Lea Berg <lea.berg@example.com> schreiben",
      "  Darf (entfernt): Löschen",
      "  Hinweis:         Kennt diesen Chat nicht. Sie weiß nur, was oben steht.",
      "  Folge:           Lea Berg <lea.berg@example.com> erfährt es",
    ]);
  });
  test("rule in English", () => {
    expect(
      actionQuestionLines(
        textFor("en", rule, {
          consequences: [{ text: "Notify {person}", slots: { person: { kind: "person", people: [lea] } }, mark: "removed" }],
        }),
        { timeZone: "UTC" },
      ),
    ).toEqual([
      "? Send message?",
      "  I'm asking because this leaves Cloud.",
      "  Starts:        Lea Berg <lea.berg@example.com> fragt",
      "  Zusammenfassen",
      "  Berichten",
      "  May (added):   Lea Berg <lea.berg@example.com> schreiben",
      "  May (removed): Löschen",
      "  Note:          Doesn't know this chat. It only knows what is written above.",
      "  Removed:       Notify Lea Berg <lea.berg@example.com>",
    ]);
  });
});

test("all message metadata, hidden recipients and attachments mark incomplete content", () => {
  expect(
    actionCardText(approvalCard({ sentence: "Mail: Send", action: "send", appName: "Mail", review: null }, "en", "UTC")).reasonCode,
  ).toBe("app_asks");
  const text = textFor("de", {
    ...message,
    cc: undefined,
    bcc: [ops],
    more: { to: 2, cc: 1 },
    moreAttachments: 1,
    warnings: ["External", "Check"],
    sendAt: "2026-10-21T16:00:00Z",
  });
  expect(text.incomplete).toBe(true);
  expect(text.rows).toContainEqual({ label: "An", value: "Lea Berg <lea.berg@example.com> und 2 weitere" });
  expect(text.rows).toContainEqual({ label: "Cc", value: "1 weitere" });
  expect(text.rows).toContainEqual({ label: "Bcc", value: "Team Ops <ops@example.com>" });
  expect(text.rows).toContainEqual({ label: "Warnung", value: "External · Check" });
  expect(text.rows).toContainEqual({ label: "Anhänge", value: "wartung.pdf (84 KB) und 1 weitere" });
  expect(actionQuestionLines(text, { timeZone: "Europe/Berlin" })).toContain("  Senden am: 21. Okt. 2026, 18:00");
});

test("task, file, page and fields retain their typed values and changes", () => {
  expect(
    textFor("de", {
      kind: "task",
      title: "Task",
      place: "Team Ops",
      due: "2026-10-21",
      assignees: [lea],
      status: "Offen",
      checklist: [
        { label: "Entwurf", done: true },
        { label: "Review", done: false },
      ],
      tags: ["Release", "Q4"],
      description: "Work",
    }).rows,
  ).toEqual([
    { label: "Titel", value: "Task" },
    { label: "Ort", value: "Team Ops" },
    { label: "Fällig", value: "2026-10-21", format: "date" },
    { label: "Zuständig", value: "Lea Berg <lea.berg@example.com>" },
    { label: "Status", value: "Offen" },
    { label: "Checkliste", value: "☑ Entwurf · ☐ Review" },
    { label: "Tags", value: "Release, Q4" },
    { label: "Text", value: "Work", block: true },
  ]);
  expect(textFor("en", { kind: "file", name: "one.pdf", path: "/drafts", size: 84_000, to: "/archive" }).rows).toEqual([
    { label: "Name", value: "one.pdf" },
    { label: "Folder", value: "/drafts" },
    { label: "Size", value: "84 KB" },
    { label: "To", value: "/archive" },
  ]);
  // A question that names the file already gets no Name row.
  expect(
    textFor(
      "de",
      { kind: "file", name: "one.pdf", to: "/archive" },
      {
        slots: { file: { kind: "object", title: "one.pdf" } },
        sentence: {
          action: "{file} verschieben",
          running: "{file} wird verschoben",
          done: "{file} verschoben",
          confirm: "Verschieben",
          decline: "Nicht verschieben",
        },
      },
    ).rows,
  ).toEqual([{ label: "Ziel", value: "/archive" }]);
  const page = textFor("de", {
    kind: "page",
    title: "Page",
    place: "Notes",
    body: "Body",
    format: "markdown",
    truncated: true,
    changes: [
      { change: "added", text: "New" },
      { change: "removed", text: "Old" },
    ],
  });
  expect(page.incomplete).toBe(true);
  expect(page.rows).toEqual([
    { label: "Titel", value: "Page" },
    { label: "Ort", value: "Notes" },
    { label: "Text", value: "Body", block: true },
    { label: "Neu", value: "New" },
    { label: "Entfernt", value: "Old" },
  ]);
  expect(
    textFor("en", { kind: "fields", rows: [{ label: "Due", value: "2026-10-21", before: "2026-10-20", format: "date" }] }).rows,
  ).toEqual([
    { label: "Due", value: "2026-10-21", format: "date" },
    { label: "Due (before)", value: "2026-10-20", format: "date" },
  ]);
});

test("single dates stay typed and calendar dates stay on their day west of UTC", () => {
  const date = textFor("en", { kind: "event", title: "Day", start: "2026-10-21", allDay: true });
  // The question does not name the event, so its title is a row of its own.
  expect(date.rows).toEqual([
    { label: "Title", value: "Day" },
    { label: "When", value: "2026-10-21", format: "date" },
  ]);
  expect(actionQuestionLines(date, { timeZone: "America/Los_Angeles" })).toContain("  When:  Oct 21, 2026");
  const when = (text: ReturnType<typeof textFor>) => text.rows.filter((row) => row.label === "When" || row.label === "Until");
  expect(
    when(
      textFor("en", { kind: "event", title: "Day", allDay: true, start: "2026-10-21T00:00:00+14:00", end: "2026-10-22T00:00:00+14:00" }),
    ),
  ).toEqual([
    { label: "When", value: "2026-10-20", format: "date" },
    { label: "Until", value: "2026-10-21", format: "date" },
  ]);
  expect(when(textFor("en", { kind: "event", title: "Meeting", start: "2026-10-21T16:00:00Z" }))).toEqual([
    { label: "When", value: "2026-10-21T16:00:00Z", format: "date-time" },
  ]);
});

test("legacy rows and Markdown flatten once; unreviewed requests use their later lines", () => {
  const input = { action: "send", sentence: "Mail: Send mail\nTo: lea@example.com\nCheck it", appName: "Mail" };
  const plain = actionCardText(approvalCard({ ...input, review: null }, "en", "UTC"));
  expect(plain.question).toBe("Send mail?");
  expect(plain.rows).toEqual([
    { label: "To", value: "lea@example.com" },
    { label: "", value: "Check it" },
  ]);
  const stored = { legacy: { question: "Old question", rows: [{ label: "", value: "Detail" }], markdown: "**Full body**" } };
  expect(actionCardText(approvalCard({ ...input, review: stored }, "de", "UTC")).rows).toEqual([
    { label: "", value: "Detail" },
    { label: "Text", value: "**Full body**", block: true },
  ]);
  const legacy = { message: "Old question", details: [{ label: "To", value: "lea@example.com" }] };
  expect(actionCardText(approvalCard({ ...input, review: legacy }, "en", "UTC")).question).toBe("Old question");
});

test("blocks show at most eight lines and one ellipsis when incomplete", () => {
  const text = textFor(
    "en",
    { ...message, body: Array.from({ length: 9 }, (_, i) => String(i + 1)).join("\n"), truncated: true },
    { links: [{ rel: "open", href: "https://cloud.example/drafts/1" }] },
  );
  const lines = actionQuestionLines(text, { timeZone: "UTC" });
  expect(lines.slice(-10)).toEqual([
    "  1",
    "  2",
    "  3",
    "  4",
    "  5",
    "  6",
    "  7",
    "  8",
    "  …",
    "  Read all: https://cloud.example/drafts/1",
  ]);
  expect(actionQuestionLines(textFor("en", { ...message, truncated: true }), { timeZone: "UTC" }).at(-1)).toBe("  …");
});

test("the incomplete marker follows the block before any consequences", () => {
  const text = textFor("en", { ...message, truncated: true }, { consequences: [{ text: "Also logs the send" }] });
  expect(actionQuestionLines(text, { timeZone: "UTC" }).slice(-3)).toEqual([
    "  das Wartungsfenster ist am Dienstag.",
    "  …",
    "  Also:        Also logs the send",
  ]);
});

test("people the question names only as 'more' leave the text incomplete unless a row lists each of them", () => {
  const people = ["a", "b", "c", "d"].map((name) => ({ name, address: `${name}@example.com` }));
  const sentence = { action: "Send to {to}", running: "Sending to {to}", done: "Sent to {to}", confirm: "Send", decline: "Don't send" };
  const review = (overrides: Partial<CapabilityActionCallReview>): CapabilityActionCallReview => ({
    locale: "en",
    ask: "sends",
    sentence,
    slots: { to: { kind: "person", people } },
    ...overrides,
  });
  const text = (value: CapabilityActionCallReview) =>
    actionCardText(reviewActionCard(value, { locale: "en", timeZone: "UTC", app: { name: "Mail", icon: "ti ti-mail" } }));
  expect(text(review({})).question).toBe("Send to a <a@example.com>, b <b@example.com>, c <c@example.com>, and 1 more?");
  expect(text(review({})).incomplete).toBe(true);
  const listed = review({
    preview: { kind: "message", from: people[0], to: people, subject: "Hi", body: "Hello", format: "plain" },
  });
  expect(text(listed).incomplete).toBe(false);
  expect(text(review({ slots: { to: { kind: "person", people: people.slice(0, 2), total: 3 } } })).incomplete).toBe(true);
});

test("people named in a consequence count for completeness too", () => {
  const lea = { name: "Lea", address: "lea@example.com" };
  const review: CapabilityActionCallReview = {
    locale: "en",
    ask: "sends",
    sentence: { action: "Send update", running: "Sending update", done: "Sent update", confirm: "Send", decline: "Don't send" },
    slots: {},
    consequences: [{ text: "Notifies {people}", slots: { people: { kind: "person", people: [lea], total: 4 } } }],
  };
  const text = actionCardText(reviewActionCard(review, { locale: "en", timeZone: "UTC", app: { name: "Mail", icon: "ti ti-mail" } }));
  expect(text.rows).toEqual([{ label: "Also", value: "Notifies Lea <lea@example.com> and 3 more" }]);
  expect(text.incomplete).toBe(true);
});

test("a long text is cut only when Read all can open it", () => {
  const body = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join("\n");
  const page = (links?: CapabilityActionCallReview["links"]) =>
    actionQuestionLines(textFor("en", { kind: "page", title: "Send message", body, format: "plain" }, links ? { links } : {}), {
      timeZone: "UTC",
    });
  expect(page().filter((line) => line.startsWith("  Line "))).toHaveLength(10);
  const linked = page([{ rel: "open", href: "https://cloud.example/notes/1" }]);
  expect(linked.filter((line) => line.startsWith("  Line "))).toHaveLength(8);
  expect(linked).toContain("  …");
  expect(linked).toContain("  Read all: https://cloud.example/notes/1");
});

test("a question that shortens a long value leaves the text incomplete", () => {
  // Two long recipients make the question longer than 400 characters, so each value is cut to 40.
  const people = ["a", "b"].map((letter) => ({ name: letter.repeat(100), address: `${letter.repeat(200)}@example.com` }));
  const review: CapabilityActionCallReview = {
    locale: "en",
    ask: "sends",
    sentence: { action: "Send to {to}", running: "Sending to {to}", done: "Sent to {to}", confirm: "Send", decline: "Don't send" },
    slots: { to: { kind: "person", people } },
  };
  const text = actionCardText(reviewActionCard(review, { locale: "en", timeZone: "UTC", app: { name: "Mail", icon: "ti ti-mail" } }));
  expect(text.question).toContain("…");
  expect(text.incomplete).toBe(true);
});

test("a shortened time counts as incomplete even when the people are listed whole", () => {
  const people = ["a", "b"].map((letter) => ({ name: letter.repeat(100), address: `${letter.repeat(200)}@example.com` }));
  const review: CapabilityActionCallReview = {
    locale: "de",
    ask: "sends",
    sentence: {
      action: "An {to} am {at} senden",
      running: "Wird an {to} gesendet",
      done: "An {to} gesendet",
      confirm: "Senden",
      decline: "Nicht senden",
    },
    slots: {
      to: { kind: "person", people },
      at: { kind: "time", start: "2026-09-21T10:00:00Z", end: "2026-09-22T10:00:00Z", format: "date-time" },
    },
    preview: { kind: "message", from: people[0], to: people, subject: "Hallo", body: "Text", format: "plain" },
  };
  const text = actionCardText(
    reviewActionCard(review, { locale: "de", timeZone: "Europe/Berlin", app: { name: "Mail", icon: "ti ti-mail" } }),
  );
  expect(text.rows.find((row) => row.label === "An")?.value).toContain(`${"a".repeat(200)}@example.com`);
  expect(text.question).not.toContain("22. Sept.");
  expect(text.incomplete).toBe(true);
});

test("a shortened time stays complete when typed rows hold both of its ends", () => {
  const people = ["a", "b"].map((letter) => ({ name: letter.repeat(100), address: `${letter.repeat(200)}@example.com` }));
  const start = "2026-09-21T10:00:00Z";
  const end = "2026-09-22T10:00:00Z";
  const review: CapabilityActionCallReview = {
    locale: "de",
    ask: "involves_people",
    sentence: {
      action: "{to} am {at} einladen",
      running: "Lädt {to} ein",
      done: "{to} eingeladen",
      confirm: "Einladen",
      decline: "Nicht einladen",
    },
    slots: { to: { kind: "person", people }, at: { kind: "time", start, end, format: "date-time" } },
    preview: { kind: "event", title: "Retro", start, end, attendees: people },
  };
  const text = actionCardText(
    reviewActionCard(review, { locale: "de", timeZone: "Europe/Berlin", app: { name: "Spaces", icon: "ti ti-calendar" } }),
  );
  expect(text.question).not.toContain("22. Sept.");
  expect(text.incomplete).toBe(false);
});
