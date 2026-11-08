import { capabilityPersonText, capabilitySentenceText } from "../_internal/capability-sentences";
import type { Block } from "../blocks/schema";
import type { CapabilityActionReviewPresentation } from "../contracts/capabilities";
import { LegacyCapabilityPreviewSchema, LegacyCapabilityReviewContentSchema } from "./legacy-review-schema";
import { boundReviewView, reviewDraft } from "./reviews";

/** Presentation only. Never feed this conversion into request hashing or consent checks. */
export function legacyReviewView(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("sentence" in value)) return value;
  const review = value as Record<string, unknown>;
  if (review.view !== undefined) return review;
  const preview = LegacyCapabilityPreviewSchema.safeParse(review.preview);
  let rawContent = review.content;
  try {
    if (typeof rawContent === "string") rawContent = JSON.parse(rawContent);
  } catch {
    return value;
  }
  const content = LegacyCapabilityReviewContentSchema.safeParse(rawContent);
  if (!preview.success && !content.success) return value;
  const locale = typeof review.locale === "string" ? review.locale : "en";
  const de = locale.startsWith("de");
  const label = (en: string, german: string) => (de ? german : en);
  const blocks: Block[] = [];
  const rows: Extract<Block, { kind: "Detail" }>["items"] = [];
  const row = (en: string, german: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) rows.push({ label: label(en, german), value });
  };
  const personList = (people: Parameters<typeof capabilityPersonText>[0][] | undefined, more = 0) =>
    [...(people ?? []).map(capabilityPersonText), ...(more ? [de ? `und ${more} weitere` : `and ${more} more`] : [])].join(", ");
  const sentence = (entry: { text: string; slots?: Parameters<typeof capabilitySentenceText>[1] }) =>
    capabilitySentenceText(entry.text, entry.slots ?? {}, { locale, timeZone: "UTC" });
  // The complete snapshot takes precedence; preview-only changes and markers survive below.
  const p = content.success ? content.data : preview.success ? preview.data : undefined;
  if (!p) return value;
  switch (p.kind) {
    case "message": {
      const more = "more" in p ? p.more : undefined;
      const context: Extract<Block, { kind: "Draft" }>["context"] = [];
      const add = (en: string, german: string, value: string) => {
        if (value) context.push({ label: label(en, german), value });
      };
      if (p.from) add("From", "Von", capabilityPersonText(p.from));
      add("To", "An", personList(p.to, more?.to));
      add("Cc", "Cc", personList(p.cc, more?.cc));
      add("Bcc", "Bcc", personList(p.bcc, more?.bcc));
      const attachments = (p.attachments ?? []).map((a) => `${a.name}${a.size === undefined ? "" : ` (${a.size} B)`}`);
      const moreAttachments = "moreAttachments" in p ? p.moreAttachments : 0;
      if (moreAttachments) attachments.push(de ? `und ${moreAttachments} weitere` : `and ${moreAttachments} more`);
      add("Attachments", "Anhänge", attachments.join(", "));
      if (p.sendAt) add("Send at", "Sendezeit", p.sendAt);
      blocks.push({
        kind: "Draft",
        context,
        fields: [
          { name: "subject", label: label("Subject", "Betreff"), type: "text", value: p.subject },
          { name: "body", label: label("Body", "Text"), type: "textarea", value: p.body },
        ],
      });
      for (const warning of p.warnings ?? [])
        blocks.push({ kind: "Notice", tone: "warning", title: label("Warning", "Warnung"), text: warning });
      break;
    }
    case "page":
      blocks.push({
        kind: "Draft",
        ...(p.place ? { context: [{ label: label("Place", "Ort"), value: p.place }] } : {}),
        fields: [
          { name: "title", label: label("Title", "Titel"), type: "text", value: p.title },
          { name: "body", label: label("Body", "Text"), type: "textarea", value: p.body },
        ],
      });
      break;
    case "event":
      row("Title", "Titel", p.title);
      row("Start", "Beginn", p.start);
      row("End", "Ende", p.end);
      row("All day", "Ganztägig", p.allDay);
      row("Time zone", "Zeitzone", p.timeZone);
      row("Place", "Ort", p.place);
      row("Location", "Adresse", p.location);
      row("Recurrence", "Wiederholung", p.recurrence);
      if (p.attendees) row("Attendees", "Teilnehmende", personList(p.attendees));
      row("Description", "Beschreibung", p.description);
      break;
    case "task":
      row("Title", "Titel", p.title);
      row("Place", "Ort", p.place);
      row("Due", "Fällig", p.due);
      if (p.assignees) row("Assignees", "Zuständig", personList(p.assignees));
      if (p.status)
        rows.push({ label: "Status", value: p.status, type: "status", states: { [p.status]: { label: p.status, tone: "neutral" } } });
      if (p.tags) row("Tags", "Tags", p.tags.join(", "));
      row("Description", "Beschreibung", p.description);
      if (p.checklist?.length)
        blocks.push({
          kind: "Table",
          title: label("Checklist", "Checkliste"),
          columns: [
            { path: ["label"], label: label("Item", "Eintrag") },
            { path: ["done"], label: label("Done", "Erledigt") },
          ],
          rows: p.checklist,
        });
      break;
    case "file":
      row("Name", "Name", p.name);
      row("Place", "Ort", p.place);
      row("Path", "Pfad", p.path);
      row("Size", "Größe", p.size);
      row("Media type", "Medientyp", p.mediaType);
      row("To", "Ziel", p.to);
      // Historic paths are filesystem paths, not authorized image endpoints. No inferred image URL.
      break;
    case "rule":
      blocks.push({ kind: "Text", text: p.does });
      row("When", "Wenn", sentence(p.when));
      row("Sees this chat", "Kennt diesen Chat", p.seesChat);
      for (const may of p.may) row(may.mark === "removed" ? "Removed" : "May", may.mark === "removed" ? "Entfernt" : "Darf", sentence(may));
      break;
    case "fields":
      rows.push(...p.rows.map((r) => ({ label: r.label, value: r.value, ...(r.before === undefined ? {} : { before: r.before }) })));
      break;
  }
  if (rows.length) blocks.unshift({ kind: "Detail", title: label("Details", "Details"), items: rows });
  const old = preview.success ? preview.data : undefined;
  if (old?.kind === "page")
    for (const change of old.changes ?? [])
      blocks.push({
        kind: "Text",
        text: `${label(change.change === "added" ? "Added" : "Removed", change.change === "added" ? "Neu" : "Entfernt")}: ${change.text}`,
      });
  const incomplete =
    !content.success &&
    old &&
    (("truncated" in old && old.truncated) ||
      (old.kind === "message" && ((old.moreAttachments ?? 0) > 0 || Object.values(old.more ?? {}).some((n) => n > 0))));
  if (incomplete)
    blocks.push({
      kind: "Notice",
      tone: "warning",
      title: label("Shortened", "Gekürzt"),
      text: label("Open the full text through the link below.", "Den ganzen Text öffnest du über den Link unten."),
    });
  const { preview: _preview, content: _content, ...rest } = review;
  return {
    ...rest,
    view: { version: 1, blocks },
    draft: { editable: false, fields: [] },
    ...(incomplete || review.contentRef ? { incomplete: true } : {}),
  };
}

/** Bind new views and convert historical snapshots without mutating the source. */
export const presentReview = (value: unknown, compact = false): unknown => {
  const converted = legacyReviewView(value);
  if (!converted || typeof converted !== "object" || !("sentence" in converted)) return converted;
  const review = converted as Extract<CapabilityActionReviewPresentation, { sentence: unknown }>;
  const view = boundReviewView(review);
  const draft = reviewDraft(view?.blocks);
  const { contentRef, view: _rawView, editedFields: _edited, ...rest } = review as typeof review & { editedFields?: string[] };
  const small = view && new TextEncoder().encode(JSON.stringify(view)).byteLength <= 32 * 1024;
  const convertedLegacy = review.draft?.editable === false;
  return {
    ...rest,
    ...(view && (!compact || small) ? { view } : {}),
    ...(!compact || !small || convertedLegacy ? (contentRef ? { contentRef } : {}) : {}),
    ...(draft ? { draft: review.draft ?? { editable: true, fields: draft.fields.map((field) => field.name) } } : {}),
  };
};
