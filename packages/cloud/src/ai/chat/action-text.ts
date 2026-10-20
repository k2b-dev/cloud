import { dates, i18n } from "@k2b/stdlib";
import { capabilityPersonText, capabilitySentenceText } from "../../_internal/capability-sentences";
import type { CapabilityAskReason, CapabilityPerson, CapabilitySentence } from "../../contracts/capabilities";
import { formatBytes } from "../../shared/format";
import type { ActionCard } from "./action-card";
import { actionMessages } from "./action-messages";

export type ActionTextRow = { label: string; value: string; format?: "date" | "date-time"; block?: true };
export type ActionQuestionText = {
  locale: string;
  question: string;
  reason: string;
  reasonCode: CapabilityAskReason;
  rows: ActionTextRow[];
  readMore?: string;
  confirm: string;
  decline: string;
  incomplete: boolean;
};

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      from: "From",
      to: "To",
      cc: "Cc",
      bcc: "Bcc",
      subject: "Subject",
      sendAt: "Send at",
      warning: "Warning",
      attachments: "Attachments",
      text: "Text",
      when: "When",
      until: "Until",
      where: "Where",
      with: "With",
      repeats: "Repeats",
      due: "Due",
      assignees: "Assignees",
      status: "Status",
      checklist: "Checklist",
      tags: "Tags",
      folder: "Folder",
      size: "Size",
      target: "To",
      place: "Place",
      added: "Added",
      removed: "Removed",
      starts: "Starts",
      may: "May",
      mayAdded: "May (added)",
      mayRemoved: "May (removed)",
      also: "Also",
      readAll: "Read all",
      title: "Title",
      name: "Name",
      note: "Note",
      before: ({ label }: { label: string }) => `${label} (before)`,
      more: ({ count }: { count: number }) => `${count.toLocaleString("en")} more`,
    },
    de: {
      from: "Von",
      to: "An",
      cc: "Cc",
      bcc: "Bcc",
      subject: "Betreff",
      sendAt: "Senden am",
      warning: "Warnung",
      attachments: "Anhänge",
      text: "Text",
      when: "Wann",
      until: "Bis",
      where: "Wo",
      with: "Mit",
      repeats: "Wiederholung",
      due: "Fällig",
      assignees: "Zuständig",
      status: "Status",
      checklist: "Checkliste",
      tags: "Tags",
      folder: "Ordner",
      size: "Größe",
      target: "Ziel",
      place: "Ort",
      added: "Neu",
      removed: "Entfernt",
      starts: "Startet",
      may: "Darf",
      mayAdded: "Darf (neu)",
      mayRemoved: "Darf (entfernt)",
      also: "Folge",
      readAll: "Ganz lesen",
      title: "Titel",
      name: "Name",
      note: "Hinweis",
      before: ({ label }) => `${label} (vorher)`,
      more: ({ count }) => `${count.toLocaleString("de")} weitere`,
    },
  },
});
export const checkActionTextMessages = () => messages.check();
/** The label for a row an old review left without one, where a transport requires labels. */
export const actionNoteLabel = (locale: string): string => messages.resolve([locale]).t.note;

/** Flatten the question card once. Transport limits and terminal escaping belong to its callers. */
export const actionCardText = (card: ActionCard): ActionQuestionText => {
  const t = messages.resolve([card.locale]).t;
  const rows: ActionTextRow[] = [];
  let incomplete = false;
  const row = (label: string, value: string | undefined, extra: Pick<ActionTextRow, "block" | "format"> = {}) => {
    if (value !== undefined && value !== "") rows.push({ label, value, ...extra });
  };
  const list = (values: string[], more = 0) => {
    if (more > 0) {
      incomplete = true;
      values.push(t.more({ count: more }));
    }
    return new Intl.ListFormat(card.locale, { type: "conjunction" }).format(values);
  };
  const people = (values: CapabilityPerson[] | undefined, more = 0) => list((values ?? []).map(capabilityPersonText), more);
  // The thing's own name, unless the question already says it.
  const named = (label: string, value: string) => {
    if (!card.questionText.includes(value)) row(label, value);
  };
  const model = card.preview;
  if (model?.kind === "legacy") {
    rows.push(...model.rows);
    row(t.text, model.markdown, { block: true });
  } else if (model?.kind === "review") {
    const context = { locale: card.locale, timeZone: model.timeZone };
    const sentence = (value: CapabilitySentence) => capabilitySentenceText(value.text, value.slots ?? model.slots ?? {}, context);
    const preview = model.preview;
    if (preview && "truncated" in preview && preview.truncated) incomplete = true;
    switch (preview?.kind) {
      case "message":
        row(t.from, preview.from && capabilityPersonText(preview.from));
        row(t.to, people(preview.to, preview.more?.to));
        row(t.cc, people(preview.cc, preview.more?.cc));
        row(t.bcc, people(preview.bcc, preview.more?.bcc));
        row(t.subject, preview.subject);
        row(t.sendAt, preview.sendAt, { format: "date-time" });
        row(t.warning, preview.warnings?.join(" · "));
        row(
          t.attachments,
          list(
            (preview.attachments ?? []).map((file) =>
              file.size === undefined ? file.name : `${file.name} (${formatBytes(file.size, { locale: card.locale })})`,
            ),
            preview.moreAttachments,
          ),
        );
        row(t.text, preview.body, { block: true });
        break;
      case "event": {
        named(t.title, preview.title);
        const dateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
        const allDay = preview.allDay === true || dateOnly(preview.start);
        // Both ends stay typed, so a device shows them in its own zone. An all-day instant becomes its calendar day
        // in the card's zone first, so no reader's zone moves it to another day.
        const day = (value: string) =>
          dateOnly(value)
            ? value
            : new Intl.DateTimeFormat("en-CA", { timeZone: model.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
                new Date(value),
              );
        const format = allDay ? "date" : "date-time";
        row(t.when, allDay ? day(preview.start) : preview.start, { format });
        if (preview.end) row(t.until, allDay ? day(preview.end) : preview.end, { format });
        row(t.where, [preview.place, preview.location].filter(Boolean).join(" · "));
        row(t.with, people(preview.attendees));
        row(t.repeats, preview.recurrence);
        row(t.text, preview.description, { block: true });
        break;
      }
      case "task":
        named(t.title, preview.title);
        row(t.place, preview.place);
        row(t.due, preview.due, { format: /^\d{4}-\d{2}-\d{2}$/.test(preview.due ?? "") ? "date" : "date-time" });
        row(t.assignees, people(preview.assignees));
        row(t.status, preview.status);
        row(t.checklist, preview.checklist?.map((item) => `${item.done ? "☑" : "☐"} ${item.label}`).join(" · "));
        row(t.tags, preview.tags?.join(", "));
        row(t.text, preview.description, { block: true });
        break;
      case "file":
        named(t.name, preview.name);
        row(t.folder, preview.place ?? preview.path);
        row(t.size, preview.size === undefined ? undefined : formatBytes(preview.size, { locale: card.locale }));
        row(t.target, preview.to);
        break;
      case "page":
        named(t.title, preview.title);
        row(t.place, preview.place);
        row(t.text, preview.body, { block: true });
        for (const change of preview.changes ?? []) row(change.change === "added" ? t.added : t.removed, change.text);
        break;
      case "rule":
        row(t.starts, sentence(preview.when));
        row(t.text, preview.does, { block: true });
        for (const may of preview.may)
          row(may.mark === "added" ? t.mayAdded : may.mark === "removed" ? t.mayRemoved : t.may, sentence(may));
        // The card's fixed line: a routine knows only its instruction, never this chat.
        if (!preview.seesChat) row(t.note, actionMessages(card.locale).ruleBlindToChat);
        break;
      case "fields":
        for (const field of preview.rows) {
          rows.push({ label: field.label, value: field.value, ...(field.format ? { format: field.format } : {}) });
          if (field.before !== undefined)
            rows.push({ label: t.before({ label: field.label }), value: field.before, ...(field.format ? { format: field.format } : {}) });
        }
        break;
    }
    for (const consequence of model.consequences)
      row(consequence.mark === "added" ? t.added : consequence.mark === "removed" ? t.removed : t.also, consequence.plain);
  }
  // A long question shortens slot values and names at most three people of a slot, then "N more". The text is
  // complete only when the question or a row shows each value whole; people the app left out are never shown.
  const shown = [card.questionText, ...rows.map((entry) => entry.value)];
  const whole = (value: string) => shown.some((text) => text.includes(value));
  const typed = (value: string, format: "date" | "date-time") =>
    rows.some((entry) => entry.value === value && (entry.format === "date-time" || entry.format === format));
  if (
    card.slotValues?.unlisted ||
    card.slotValues?.values.some((value) => !whole(value)) ||
    card.slotValues?.times.some(
      (time) => !whole(time.text) && !(typed(time.start, time.format) && (!time.end || typed(time.end, time.format))),
    )
  )
    incomplete = true;
  return {
    locale: card.locale,
    question: card.questionText,
    reason: card.reason.text,
    reasonCode: card.reason.code,
    rows,
    ...(card.readMore ? { readMore: card.readMore } : {}),
    confirm: card.confirm.label,
    decline: card.decline,
    incomplete,
  };
};

/** The CLI's plain question block, before terminal-safe sanitizing at the CLI boundary. */
export const actionQuestionLines = (
  text: ActionQuestionText,
  extra: { origin?: string; commands?: { approve: string; reject: string }; timeZone: string },
): string[] => {
  const t = messages.resolve([text.locale]).t;
  const lines = [`? ${text.question}`, `  ${text.reason}`];
  if (extra.origin) lines.push(`  ${extra.origin}`);
  const width = Math.max(0, ...text.rows.filter((row) => !row.block && row.label).map((row) => Array.from(row.label).length + 1));
  let markedIncomplete = false;
  for (const row of text.rows) {
    if (row.block) {
      const body = row.value.split(/\r?\n/);
      // Cut a long text only when "Read all" can open the whole thing; otherwise the terminal shows all of it.
      const shown = text.readMore ? body.slice(0, 8) : body;
      lines.push(...shown.map((line) => `  ${line}`));
      if (shown.length < body.length || (text.incomplete && !markedIncomplete)) {
        lines.push("  …");
        markedIncomplete = true;
      }
      continue;
    }
    const options = { locale: text.locale, timeZone: extra.timeZone };
    const value =
      row.format === "date-time"
        ? dates.formatDateTime(row.value, options)
        : row.format === "date"
          ? dates.formatDate(/^\d{4}-\d{2}-\d{2}$/.test(row.value) ? `${row.value}T12:00:00.000Z` : row.value, {
              ...options,
              ...(/^\d{4}-\d{2}-\d{2}$/.test(row.value) ? { timeZone: "UTC" } : {}),
            })
          : row.value;
    lines.push(row.label ? `  ${(row.label + ":").padEnd(width)} ${value}` : `  ${value}`);
  }
  if (text.incomplete && !markedIncomplete) lines.push("  …");
  if (text.readMore) lines.push(`  ${t.readAll}: ${text.readMore}`);
  if (extra.commands) {
    const width = Math.max(Array.from(text.confirm).length, Array.from(text.decline).length) + 1;
    lines.push(
      `  ${(text.confirm + ":").padEnd(width)} ${extra.commands.approve}`,
      `  ${(text.decline + ":").padEnd(width)} ${extra.commands.reject}`,
    );
  }
  return lines;
};
