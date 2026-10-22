import type { CapabilityActionCallReview, CapabilityActionReview } from "../../contracts/capabilities";
import type { AiStoredActionReview } from "../action-review";
import type { AiTurnBlock } from "../protocol";
import type { AiToolPresentation } from "../types";

/**
 * Demo questions for tests and screenshots: every preview kind and the card v4 scenarios, in German and English, until
 * the apps return their own reviews. Fixed times, so nothing depends on the day a test runs.
 */

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
export type ActionFixtureLocale = "de" | "en";

export const FIXTURE_AT = "2026-10-17T12:02:00.000Z";

const app = (appId: string, appName: string, appIcon: string, appAccent: string, title: string): AiToolPresentation => ({
  kind: "capability",
  appId,
  appName,
  appIcon,
  appAccent,
  title,
  capabilityKind: "action",
});

const MAIL = (l: ActionFixtureLocale) => app("mail", "Mail", "ti ti-mail", "#0f766e", l === "de" ? "Entwurf senden" : "Send draft");
const FILES = (l: ActionFixtureLocale) => app("files", "Files", "ti ti-folder", "#1d4ed8", l === "de" ? "Ordner teilen" : "Share folder");
const SPACES = (l: ActionFixtureLocale, title: string) => app("spaces", "Spaces", "ti ti-layout-kanban", "#4d7c0f", title);
const NOTES = (l: ActionFixtureLocale) =>
  app("notebooks", "Notebooks", "ti ti-notebook", "#a16207", l === "de" ? "Notiz ergänzen" : "Add to note");
const ASSISTANT = (title: string) => app("core", "Assistant", "ti ti-sparkles", "#0e7490", title);

const lea = { name: "Lea Berg", address: "lea.berg@example.com" };
const tom = { name: "Tom Weber", address: "tom.weber@k2b.dev" };
const mira = { name: "Mira Hoffmann", address: "mira.hoffmann@k2b.dev" };
const valentin = { name: "Valentin Kolb", address: "valentin.kolb@k2b.dev" };

const draftRef = { type: "mail.draft", id: "dr-42" };
const mailBody = (l: ActionFixtureLocale) =>
  l === "de"
    ? "Hallo Lea,\ndas Wartungsfenster ist am Dienstag, 21.10., von 18 bis 20 Uhr. In der Zeit sind Mail und Files kurz nicht erreichbar. Montag um 9 planen wir die Details, am Donnerstag schauen wir im Review zurück.\n\nViele Grüße\nValentin"
    : "Hi Lea,\nthe maintenance window is on Tuesday, Oct 21, from 6 to 8 pm. Mail and Files are briefly unavailable then. We plan the details on Monday at 9 and look back in the review on Thursday.\n\nBest\nValentin";

const mailReview = (l: ActionFixtureLocale, scheduled: boolean): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: scheduled ? "Mail {subject} an {to} am {at} senden" : "Mail {subject} an {to} senden",
          running: scheduled ? "Mail {subject} an {to} wird für {at} geplant …" : "Mail {subject} an {to} wird gesendet …",
          done: scheduled ? "Mail {subject} an {to} geplant für {at}." : "Mail {subject} an {to} wird gesendet.",
          confirm: "An {to} senden",
          decline: "Nicht senden",
          rejected: scheduled ? "Mail {subject} an {to} nicht geplant." : "Mail {subject} an {to} nicht gesendet.",
          short: "Mail an {to} senden",
        }
      : {
          action: scheduled ? "Send the email {subject} to {to} on {at}" : "Send the email {subject} to {to}",
          running: scheduled ? "Scheduling the email {subject} to {to} for {at} …" : "Sending the email {subject} to {to} …",
          done: scheduled ? "The email {subject} to {to} is scheduled for {at}." : "The email {subject} to {to} is being sent.",
          confirm: "Send to {to}",
          decline: "Don't send",
          rejected: scheduled ? "Didn't schedule the email {subject} to {to}." : "Didn't send the email {subject} to {to}.",
          short: "Send email to {to}",
        },
  slots: {
    subject: {
      kind: "object",
      title: l === "de" ? "Wartungsfenster Dienstag" : "Maintenance window Tuesday",
      ref: draftRef,
      icon: "ti ti-mail",
    },
    to: { kind: "person", people: [lea] },
    ...(scheduled ? { at: { kind: "time" as const, start: "2026-10-20T06:00:00.000Z", format: "date-time" as const } } : {}),
  },
  preview: {
    kind: "message",
    from: valentin,
    to: [lea],
    ...(scheduled ? { cc: [mira], bcc: [tom], sendAt: "2026-10-20T06:00:00.000Z" } : {}),
    subject: l === "de" ? "Wartungsfenster Dienstag" : "Maintenance window Tuesday",
    body: mailBody(l),
    format: "plain",
    truncated: true,
    attachments: [{ name: "Wartungsplan-KW43.pdf", size: 84_000 }],
    ...(scheduled
      ? {
          warnings: [
            l === "de"
              ? "1 externer Empfänger. Diese E-Mail verlässt die für das Postfach festgelegten internen Domains."
              : "1 external recipient. This email leaves the internal domains set for the mailbox.",
          ],
        }
      : {}),
  },
  ask: "sends",
  check: { query: "delivery.read", input: { draftId: "dr-42" } },
  links: [{ rel: "open", href: "/app/mail/drafts/dr-42?revision=7" }],
});

const shareReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Ordner {folder} mit {person} zum Bearbeiten teilen",
          running: "Ordner {folder} wird mit {person} geteilt …",
          done: "Ordner {folder} mit {person} geteilt.",
          confirm: "Mit {person} teilen",
          decline: "Nicht teilen",
          rejected: "Ordner {folder} nicht geteilt.",
        }
      : {
          action: "Share the folder {folder} with {person} for editing",
          running: "Sharing the folder {folder} with {person} …",
          done: "Shared the folder {folder} with {person}.",
          confirm: "Share with {person}",
          decline: "Don't share",
          rejected: "Didn't share the folder {folder}.",
        },
  slots: {
    folder: {
      kind: "object",
      title: l === "de" ? "Rechnungen 2026" : "Invoices 2026",
      ref: { type: "files.folder", id: "f-1" },
      icon: "ti ti-folder",
    },
    person: { kind: "person", people: [tom] },
  },
  preview: {
    kind: "file",
    name: l === "de" ? "Rechnungen 2026" : "Invoices 2026",
    place: l === "de" ? "48 Dateien in 3 Ordnern" : "48 files in 3 folders",
  },
  consequences:
    l === "de"
      ? [
          { text: "Tom kann alles darin ansehen, ändern, hochladen und löschen, auch was später dazukommt.", mark: "added" },
          { text: "Er bekommt eine Benachrichtigung mit dem Link." },
          { text: "Zurücknehmen kannst du das jederzeit in Files." },
        ]
      : [
          { text: "Tom can view, change, upload and delete everything in it, including what is added later.", mark: "added" },
          { text: "He gets a notification with the link." },
          { text: "You can take this back any time in Files." },
        ],
  ask: "changes_access",
});

const deleteReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Termin {event} am {day} löschen",
          running: "Termin {event} am {day} wird gelöscht …",
          done: "Termin {event} am {day} gelöscht.",
          confirm: "{event} löschen",
          decline: "Behalten",
          rejected: "Termin {event} bleibt im Kalender.",
        }
      : {
          action: "Delete the event {event} on {day}",
          running: "Deleting the event {event} on {day} …",
          done: "Deleted the event {event} on {day}.",
          confirm: "Delete {event}",
          decline: "Keep it",
          rejected: "The event {event} stays in the calendar.",
        },
  slots: {
    event: { kind: "object", title: "Retro", ref: { type: "spaces.event", id: "ev-17" }, icon: "ti ti-calendar" },
    day: { kind: "time", start: "2026-10-17", format: "date" },
  },
  preview: {
    kind: "event",
    title: "Retro",
    start: "2026-10-17T13:00:00.000Z",
    end: "2026-10-17T14:00:00.000Z",
    timeZone: "Europe/Berlin",
    location: l === "de" ? "Raum 2.14" : "Room 2.14",
    place: l === "de" ? "im Kalender von Team Ops" : "in the Team Ops calendar",
    attendees: [lea, tom, mira, { name: "Jonas Klein" }, { name: "Ada Lovelace" }, { name: "Sam Ortiz" }],
  },
  consequences: [
    {
      text:
        l === "de"
          ? "Die 6 Personen bekommen dadurch keine Absage. Eine Absage-Mail wäre ein eigener Schritt."
          : "The 6 people get no cancellation from this. A cancellation email would be a separate step.",
    },
  ],
  ask: "deletes",
});

const deletedReceipt = (l: ActionFixtureLocale) => ({
  text: l === "de" ? "Termin {event} am {day} gelöscht." : "Deleted the event {event} on {day}.",
  slots: {
    event: { kind: "object" as const, title: "Retro", icon: "ti ti-calendar", gone: true as const },
    day: { kind: "time" as const, start: "2026-10-17", format: "date" as const },
  },
});

const teamOps = { kind: "place" as const, title: "Team Ops", ref: { type: "spaces.space", id: "sp-ops" }, icon: "ti ti-layout-kanban" };
const marketing = { kind: "place" as const, title: "Marketing", ref: { type: "spaces.space", id: "sp-mkt" }, icon: "ti ti-layout-kanban" };
const newTasks = (l: ActionFixtureLocale) => ({
  kind: "object" as const,
  title: l === "de" ? "Neue Aufgaben" : "New tasks",
  ref: { type: "notebooks.page", id: "pg-new" },
  icon: "ti ti-notes",
});

const routineSlot = (l: ActionFixtureLocale) => ({
  kind: "object" as const,
  title: l === "de" ? "Neue Aufgaben zusammenfassen" : "Summarize new tasks",
  ref: { type: "core.routine", id: "rt-1" },
  icon: "ti ti-bolt",
});

const routineReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Routine {routine} anlegen",
          running: "Routine {routine} wird angelegt …",
          done: "Routine {routine} angelegt.",
          confirm: "Routine anlegen",
          decline: "Nicht anlegen",
          rejected: "Routine {routine} nicht angelegt.",
        }
      : {
          action: "Create the routine {routine}",
          running: "Creating the routine {routine} …",
          done: "Created the routine {routine}.",
          confirm: "Create routine",
          decline: "Don't create",
          rejected: "Didn't create the routine {routine}.",
        },
  slots: { routine: routineSlot(l) },
  preview: {
    kind: "rule",
    when: {
      text:
        l === "de"
          ? "Immer wenn in {space} eine neue Aufgabe entsteht, ergänze ich {note} um einen Satz mit Titel, Zuständigen und Fälligkeit."
          : "Whenever a new task is added in {space}, I add one sentence with title, owner and due date to {note}.",
      slots: { space: teamOps, note: newTasks(l) },
    },
    does: "",
    may:
      l === "de"
        ? [
            { text: "Liest neue Aufgaben in Team Ops, keine Termine." },
            { text: "Ergänzt nur die Notiz „Neue Aufgaben“." },
            { text: "Sendet, löscht und teilt nichts und fragt dich nie." },
          ]
        : [
            { text: "Reads new tasks in Team Ops, no events." },
            { text: "Only adds to the note “New tasks”." },
            { text: "Sends, deletes and shares nothing and never asks you." },
          ],
    seesChat: false,
  },
  ask: "keeps_working",
  check: { query: "ai.task.read", input: { name: "summarize" } },
});

const rightReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Routine {routine} auch {space} lesen lassen",
          running: "Routine {routine} bekommt {space} dazu …",
          done: "Routine {routine} liest jetzt auch {space}.",
          confirm: "{space} dazunehmen",
          decline: "So lassen",
          rejected: "Routine {routine} unverändert.",
        }
      : {
          action: "Let the routine {routine} also read {space}",
          running: "Adding {space} to the routine {routine} …",
          done: "The routine {routine} now also reads {space}.",
          confirm: "Add {space}",
          decline: "Leave as is",
          rejected: "The routine {routine} is unchanged.",
        },
  slots: { routine: routineSlot(l), space: marketing },
  preview: {
    kind: "rule",
    when: {
      text:
        l === "de"
          ? "Immer wenn in {ops} oder {mkt} eine neue Aufgabe entsteht, ergänze ich {note} um einen Satz."
          : "Whenever a new task is added in {ops} or {mkt}, I add one sentence to {note}.",
      slots: { ops: teamOps, mkt: marketing, note: newTasks(l) },
    },
    does: "",
    may:
      l === "de"
        ? [
            { text: "Liest neue Aufgaben in Team Ops." },
            { text: "Liest neue Aufgaben in Marketing.", mark: "added" },
            { text: "Ergänzt nur die Notiz „Neue Aufgaben“." },
          ]
        : [
            { text: "Reads new tasks in Team Ops." },
            { text: "Reads new tasks in Marketing.", mark: "added" },
            { text: "Only adds to the note “New tasks”." },
          ],
    seesChat: false,
  },
  ask: "keeps_working",
});

const skillReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Skill {skill} anlegen",
          running: "Skill {skill} wird angelegt …",
          done: "Skill {skill} angelegt.",
          confirm: "Skill anlegen",
          decline: "Nicht anlegen",
          rejected: "Skill {skill} nicht angelegt.",
        }
      : {
          action: "Create the Skill {skill}",
          running: "Creating the Skill {skill} …",
          done: "Created the Skill {skill}.",
          confirm: "Create Skill",
          decline: "Don't create",
          rejected: "Didn't create the Skill {skill}.",
        },
  slots: { skill: { kind: "object", title: l === "de" ? "Wochenbericht" : "Weekly report", icon: "ti ti-sparkles" } },
  preview: {
    kind: "rule",
    when: {
      text:
        l === "de"
          ? "Wenn du nach einem Wochenbericht fragst, lese ich die erledigten Aufgaben in {space} und schreibe den Bericht wie in {note}."
          : "When you ask for a weekly report, I read the completed tasks in {space} and write the report like {note}.",
      slots: { space: teamOps, note: { kind: "object", title: l === "de" ? "Woche 42" : "Week 42", icon: "ti ti-notes" } },
    },
    does:
      l === "de"
        ? "1. Nur erledigte Aufgaben der laufenden Woche.\n2. Drei Abschnitte: Erledigt, Hängt, Nächste Woche.\n3. Höchstens eine Seite, Namen statt Kürzel."
        : "1. Only tasks completed this week.\n2. Three sections: Done, Stuck, Next week.\n3. One page at most, names instead of initials.",
    may:
      l === "de"
        ? [
            { text: "Ist sofort eingeschaltet und gilt in allen deinen späteren Chats.", mark: "added" },
            { text: "Nur du nutzt ihn. Teilen wäre ein eigener Schritt." },
            { text: "Gibt mir keine neuen Rechte. Ich darf damit nur, was ich ohnehin darf." },
          ]
        : [
            { text: "Is on at once and applies in all your later chats.", mark: "added" },
            { text: "Only you use it. Sharing would be a separate step." },
            { text: "Gives me no new rights. I can only do what I may do anyway." },
          ],
    seesChat: true,
  },
  ask: "keeps_working",
  links: [{ rel: "open", href: "/app/assistant/skills/weekly" }],
});

const resumeReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Routine {routine} fortsetzen",
          running: "Routine {routine} wird fortgesetzt …",
          done: "Routine {routine} läuft wieder.",
          confirm: "Fortsetzen",
          decline: "Pausiert lassen",
          rejected: "Routine {routine} bleibt pausiert.",
        }
      : {
          action: "Resume the routine {routine}",
          running: "Resuming the routine {routine} …",
          done: "The routine {routine} runs again.",
          confirm: "Resume",
          decline: "Keep paused",
          rejected: "The routine {routine} stays paused.",
        },
  slots: { routine: routineSlot(l) },
  preview: {
    kind: "rule",
    when: {
      text:
        l === "de"
          ? "Immer wenn in {space} eine neue Aufgabe entsteht, ergänze ich {note} um einen Satz mit Titel, Zuständigen und Fälligkeit."
          : "Whenever a new task is added in {space}, I add one sentence with title, owner and due date to {note}.",
      slots: { space: teamOps, note: newTasks(l) },
    },
    does: "",
    may:
      l === "de"
        ? [
            { text: "Liest neue Aufgaben in Team Ops, keine Termine." },
            { text: "Ergänzt nur die Notiz „Neue Aufgaben“." },
            { text: "Was seit der Pause am Mo 13.10. passiert ist, holt sie nicht von selbst nach." },
          ]
        : [
            { text: "Reads new tasks in Team Ops, no events." },
            { text: "Only adds to the note “New tasks”." },
            { text: "What happened since the pause on Mon Oct 13 is not caught up by itself." },
          ],
    seesChat: false,
  },
  ask: "keeps_working",
});

const noteReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Notiz {note} um 1 Absatz ergänzen",
          running: "Notiz {note} wird ergänzt …",
          done: "Notiz {note} um 1 Absatz ergänzt.",
          confirm: "Ergänzen",
          decline: "Nicht ergänzen",
          rejected: "Notiz {note} unverändert.",
        }
      : {
          action: "Add 1 paragraph to the note {note}",
          running: "Adding to the note {note} …",
          done: "Added 1 paragraph to the note {note}.",
          confirm: "Add it",
          decline: "Don't add",
          rejected: "The note {note} is unchanged.",
        },
  slots: {
    note: { kind: "object", title: l === "de" ? "Woche 42" : "Week 42", ref: { type: "notebooks.page", id: "pg-42" }, icon: "ti ti-notes" },
  },
  preview: {
    kind: "page",
    title: l === "de" ? "Woche 42" : "Week 42",
    place: l === "de" ? "Abschnitt „Aufgaben“" : "section “Tasks”",
    body:
      l === "de"
        ? "Wartungsfenster Dienstag 18 bis 20 Uhr, Mail und Files kurz offline."
        : "Maintenance window Tuesday 6 to 8 pm, Mail and Files briefly offline.",
    format: "plain",
    changes: [
      {
        change: "added",
        text:
          l === "de"
            ? "Aufgaben dazu in Team Ops: Server-Update vorbereiten, Monitoring prüfen, Kunden informieren, Backups testen."
            : "Tasks in Team Ops: prepare server update, check monitoring, inform customers, test backups.",
      },
    ],
  },
  ask: "app_asks",
  links: [{ rel: "open", href: "/app/notebooks/pg-42" }],
});

const taskReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Aufgabe {task} in {space} anlegen und {person} zuweisen",
          running: "Aufgabe {task} wird in {space} angelegt und {person} zugewiesen …",
          done: "Aufgabe {task} in {space} angelegt und {person} zugewiesen.",
          confirm: "Lea zuweisen",
          decline: "Nicht anlegen",
          rejected: "Aufgabe {task} nicht angelegt.",
        }
      : {
          action: "Create the task {task} in {space} and assign it to {person}",
          running: "Creating the task {task} in {space} for {person} …",
          done: "Created the task {task} in {space} for {person}.",
          confirm: "Assign to Lea",
          decline: "Don't create",
          rejected: "Didn't create the task {task}.",
        },
  slots: {
    task: { kind: "object", title: l === "de" ? "Backups testen" : "Test backups", icon: "ti ti-checkbox" },
    space: teamOps,
    person: { kind: "person", people: [lea] },
  },
  preview: {
    kind: "task",
    title: l === "de" ? "Backups testen" : "Test backups",
    place: "Team Ops",
    due: "2026-10-21",
    assignees: [lea],
    status: l === "de" ? "Offen" : "Open",
    checklist:
      l === "de"
        ? [
            { label: "Restore auf Staging", done: false },
            { label: "Ergebnis in Woche 42 notieren", done: false },
          ]
        : [
            { label: "Restore on staging", done: false },
            { label: "Note the result in Week 42", done: false },
          ],
    tags: ["ops", "backup"],
  },
  ask: "involves_people",
});

const fieldsReview = (l: ActionFixtureLocale): CapabilityActionCallReview => ({
  locale: l,
  sentence:
    l === "de"
      ? {
          action: "Kontakt {contact} ändern",
          running: "Kontakt {contact} wird geändert …",
          done: "Kontakt {contact} geändert.",
          confirm: "Ändern",
          decline: "Nicht ändern",
          rejected: "Kontakt {contact} unverändert.",
        }
      : {
          action: "Change the contact {contact}",
          running: "Changing the contact {contact} …",
          done: "Changed the contact {contact}.",
          confirm: "Change it",
          decline: "Don't change",
          rejected: "The contact {contact} is unchanged.",
        },
  slots: { contact: { kind: "object", title: "Nordwind GmbH", ref: { type: "contacts.contact", id: "c-9" }, icon: "ti ti-address-book" } },
  preview: {
    kind: "fields",
    rows: [
      { label: "IBAN", value: "DE89 3704 0044 0532 0130 00", before: "DE02 1203 0000 0000 2020 51" },
      { label: l === "de" ? "Zahlungsziel" : "Payment terms", value: l === "de" ? "30 Tage" : "30 days" },
      { label: l === "de" ? "Geändert am" : "Changed on", value: "2026-10-17", format: "date" },
    ],
  },
  ask: "sensitive",
});

/** An old review with everything an old app could send: a long message with braces, 20 details, and Markdown. */
const legacyReview = (l: ActionFixtureLocale): CapabilityActionReview => ({
  message:
    `${l === "de" ? "Sendet den Entwurf {nicht als Vorlage} an alle Empfänger." : "Sends the draft {not as a template} to every recipient."} ${"{x} ".repeat(260)}`.slice(
      0,
      1000,
    ),
  details: [
    ...Array.from({ length: 18 }, (_, index) => ({
      label: `${l === "de" ? "Feld" : "Field"} ${index + 1}`,
      value: `{value ${index + 1}}`,
    })),
    { label: l === "de" ? "Gesendet am" : "Sent on", value: "2026-10-20T06:00:00.000Z", format: "date-time" as const },
    {
      label: "Text",
      value:
        l === "de"
          ? "## Hallo Lea\n\n- **Dienstag** 18 bis 20 Uhr\n- Mail und Files kurz offline"
          : "## Hi Lea\n\n- **Tuesday** 6 to 8 pm\n- Mail and Files briefly offline",
      display: "block" as const,
      format: "markdown" as const,
    },
  ],
  links: [{ rel: "edit", href: "/app/mail/drafts/dr-42" }],
});

export type ActionFixture = {
  key: string;
  user: string;
  assistant: string;
  block: ToolBlock;
};

const block = (
  callId: string,
  name: string,
  presentation: AiToolPresentation,
  review: AiStoredActionReview | CapabilityActionReview,
  extra: Partial<ToolBlock> = {},
): ToolBlock => {
  const stored = "sentence" in review || "legacy" in review ? (review as AiStoredActionReview) : undefined;
  return {
    id: `tool-${callId}`,
    kind: "tool",
    callId,
    name,
    args: { draftId: "dr-42" },
    status: "awaiting_approval",
    presentation,
    ...(stored ? { review: stored } : {}),
    approval: {
      message: `${presentation.appName}: ${presentation.title}`,
      ...(stored ? {} : { review: review as CapabilityActionReview }),
      allowAlways: false,
      allowChat: false,
    },
    ...extra,
  };
};

/** Every scenario of card v4 with its question open. Tests and the gallery move it to other states. */
export const actionFixtures = (l: ActionFixtureLocale): Record<string, ActionFixture> => {
  const de = l === "de";
  return {
    mail: {
      key: "mail",
      user: de ? "Schick Lea die Zeiten fürs Wartungsfenster." : "Send Lea the times for the maintenance window.",
      assistant: de ? "Ich habe die Zeiten aus Woche 42 in einen Entwurf geschrieben." : "I put the times from Week 42 into a draft.",
      block: block("mail-1", "mail__action__draft_dot_send", MAIL(l), mailReview(l, false)),
    },
    sched: {
      key: "sched",
      user: de
        ? "Schick Lea die Zeiten am Montag früh, Mira in Kopie und Tom in Blindkopie."
        : "Send Lea the times early Monday, Mira in Cc and Tom in Bcc.",
      assistant: de
        ? "Der Entwurf ist fertig. Mail weist auf einen externen Empfänger hin."
        : "The draft is ready. Mail points out an external recipient.",
      block: block("sched-1", "mail__action__draft_dot_send", MAIL(l), mailReview(l, true)),
    },
    share: {
      key: "share",
      user: de
        ? "Gib Tom Zugriff auf die Rechnungen, er übernimmt ab November die Buchhaltung."
        : "Give Tom access to the invoices; he takes over the bookkeeping in November.",
      assistant: de ? "Tom hat bisher keinen Zugriff auf den Ordner." : "Tom has no access to the folder yet.",
      block: block("share-1", "files__action__share_dot_create", FILES(l), shareReview(l)),
    },
    del: {
      key: "del",
      user: de ? "Die Retro am Freitag fällt aus, nimm sie raus." : "Friday's retro is cancelled, remove it.",
      assistant: de ? "Die Retro steht einmal im Kalender, nicht als Serie." : "The retro is in the calendar once, not as a series.",
      block: block("del-1", "spaces__action__event_dot_delete", SPACES(l, de ? "Termin löschen" : "Delete event"), deleteReview(l)),
    },
    routine: {
      key: "routine",
      user: de
        ? "Immer wenn in Team Ops eine neue Aufgabe entsteht, fass sie mir in der Notiz „Neue Aufgaben“ zusammen."
        : "Whenever a new task is added in Team Ops, summarize it for me in the note “New tasks”.",
      assistant: de
        ? "Das richte ich als Routine ein. Sie kennt diesen Chat nicht, deshalb schreibe ich alles Nötige in ihren Auftrag."
        : "I'll set this up as a routine. It doesn't see this chat, so I'm putting everything it needs into its instructions.",
      block: block(
        "routine-1",
        "core__action__ai_dot_task_dot_create",
        ASSISTANT(de ? "Routine anlegen" : "Create routine"),
        routineReview(l),
      ),
    },
    right: {
      key: "right",
      user: de ? "Nimm Marketing bei der Routine auch dazu." : "Add Marketing to the routine too.",
      assistant: de
        ? "Dafür muss die Routine auch Marketing lesen dürfen. Das Neue ist markiert."
        : "For that the routine also needs to read Marketing. What's new is marked.",
      block: block("right-1", "core__action__ai_dot_task_dot_update", ASSISTANT(de ? "Routine ändern" : "Change routine"), rightReview(l)),
    },
    skill: {
      key: "skill",
      user: de
        ? "Merk dir, wie ich Wochenberichte haben will, und mach das künftig immer so."
        : "Remember how I want weekly reports and always do it that way from now on.",
      assistant: de
        ? "Das lege ich als Skill an. Er gilt dann in jedem deiner Chats, deshalb frage ich vorher."
        : "I'll set this up as a Skill. It then applies in every chat of yours, so I ask first.",
      block: block("skill-1", "core__action__ai_dot_skill_dot_create", ASSISTANT(de ? "Skill anlegen" : "Create Skill"), skillReview(l)),
    },
    resume: {
      key: "resume",
      user: de ? "Lass die Routine wieder laufen." : "Let the routine run again.",
      assistant: de ? "Sie darf danach wieder dasselbe wie vorher, ohne dich." : "It may then do the same as before again, without you.",
      block: block(
        "resume-1",
        "core__action__ai_dot_task_dot_resume",
        ASSISTANT(de ? "Routine fortsetzen" : "Resume routine"),
        resumeReview(l),
      ),
    },
    note: {
      key: "note",
      user: de ? "Schreib die Aufgaben in Woche 42." : "Put the tasks into Week 42.",
      assistant: de ? "Ich ergänze den Abschnitt „Aufgaben“." : "I'll add to the section “Tasks”.",
      block: block("note-1", "notebooks__action__page_dot_append", NOTES(l), noteReview(l), {
        approval: { message: "Notebooks", allowAlways: false, allowChat: true },
      }),
    },
    task: {
      key: "task",
      user: de ? "Leg „Backups testen“ in Team Ops an, Lea übernimmt." : "Create “Test backups” in Team Ops, Lea takes it.",
      assistant: de ? "Lea ist Mitglied von Team Ops." : "Lea is a member of Team Ops.",
      block: block("task-1", "spaces__action__task_dot_create", SPACES(l, de ? "Aufgabe anlegen" : "Create task"), taskReview(l)),
    },
    fields: {
      key: "fields",
      user: de ? "Nordwind hat eine neue Bankverbindung, trag sie ein." : "Nordwind has new bank details, put them in.",
      assistant: de ? "Ich ändere die IBAN im Kontakt." : "I'll change the IBAN in the contact.",
      block: block(
        "fields-1",
        "contacts__action__contact_dot_update",
        app("contacts", "Contacts", "ti ti-address-book", "#7c3aed", de ? "Kontakt ändern" : "Change contact"),
        fieldsReview(l),
      ),
    },
    legacy: {
      key: "legacy",
      user: de ? "Schick den Entwurf raus." : "Send the draft out.",
      assistant: de ? "Mail fragt dafür noch in der alten Form." : "Mail still asks in the old form for this.",
      block: block("legacy-1", "mail__action__draft_dot_send", MAIL(l), legacyReview(l)),
    },
    website: {
      key: "website",
      user: de ? "Wie steht NVDA gerade?" : "How is NVDA doing right now?",
      assistant: de ? "Ich frage den Kurs ab." : "I'll look up the quote.",
      block: {
        id: "tool-run",
        kind: "tool",
        callId: "run-approval-0",
        name: "code_run",
        args: {},
        status: "awaiting_approval",
        approval: {
          message: "HTTP request: GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=NVDA",
          allowAlways: false,
          allowChat: true,
          website: "https://query1.finance.yahoo.com",
        },
      },
    },
  };
};

/** The receipt a delete returns: the deleted event's chip is struck through and no link. */
export const actionFixtureReceipts = (l: ActionFixtureLocale) => ({ del: deletedReceipt(l) });
