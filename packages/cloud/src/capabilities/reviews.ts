import { capabilityPersonText, capabilityReviewSentence, capabilitySentenceText } from "../_internal/capability-sentences";
import {
  CAPABILITY_MAX_REVIEW_BYTES,
  type CapabilityActionLegacyReview,
  type CapabilityActionReview,
  type CapabilityActionReviewData,
  CapabilityActionReviewSchema,
  type CapabilityPreview,
  type CapabilitySemanticLink,
  type CapabilitySlot,
} from "../contracts/capabilities";
import { canonicalLocale } from "../shared/locale";
export const capabilityPreviewIssues = (
  preview: CapabilityPreview | undefined,
  links: readonly CapabilitySemanticLink[] | undefined,
  sends = false,
): string[] => {
  if (!preview) return [];
  const issues: string[] = [];
  const open = links?.some((link) => link.rel === "open");
  if ("truncated" in preview && preview.truncated && !open) issues.push("A truncated preview requires an open link");
  if (preview.kind === "message") {
    if ((Object.values(preview.more ?? {}).some((count) => count > 0) || (preview.moreAttachments ?? 0) > 0) && !open)
      issues.push("Unlisted recipients or attachments require an open link");
    if (sends && !preview.from) issues.push("A sends message requires from");
  }
  return issues;
};
/** Context-free rules shared by the builder and runtime validation. */
export const capabilityReviewFormIssues = (review: CapabilityActionReview): string[] => {
  const issues: string[] = [];
  if (canonicalLocale(review.locale) !== review.locale) return ["locale must be a canonical BCP 47 tag"];
  for (const form of ["confirm", "decline"] as const)
    if (Array.from(capabilityReviewSentence(review, form, { timeZone: "UTC" })).length > 40)
      issues.push(`${form} exceeds 40 rendered characters`);
  issues.push(...capabilityPreviewIssues(review.preview, review.links, review.ask === "sends"));
  try {
    if (new TextEncoder().encode(JSON.stringify(review)).byteLength > CAPABILITY_MAX_REVIEW_BYTES) issues.push("Review exceeds 32 KiB");
  } catch {
    issues.push("Review is not JSON serializable");
  }
  return issues;
};
export type CapabilityReviewForms = Pick<CapabilityActionReview, "locale" | "sentence">;
export type SlotNames<Text extends string> = string extends Text
  ? string
  : Text extends `${string}{${infer Name}}${infer Rest}`
    ? Name | SlotNames<Rest>
    : never;
type FormNames<Forms extends CapabilityReviewForms> = SlotNames<Extract<Forms["sentence"][keyof Forms["sentence"]], string>>;
type CheckedForms<Forms extends CapabilityReviewForms> =
  string extends FormNames<Forms>
    ? unknown
    : Exclude<FormNames<Forms>, SlotNames<Forms["sentence"]["action"]>> extends never
      ? unknown
      : never;
type ActionSlotNames<Forms extends CapabilityReviewForms> =
  string extends FormNames<Forms> ? string : SlotNames<Forms["sentence"]["action"]>;
/** Build a review without I/O. Literal forms enforce the exact slot set at compile time. */
export const actionReview = <const Forms extends CapabilityReviewForms, const Slots extends Record<string, CapabilitySlot>>(
  forms: Forms & CheckedForms<Forms>,
  slots: Slots & Record<ActionSlotNames<Forms>, CapabilitySlot> & Record<Exclude<keyof Slots, ActionSlotNames<Forms>>, never>,
  extra?: Omit<CapabilityActionReview, "locale" | "sentence" | "slots">,
): CapabilityActionReview => {
  const review = CapabilityActionReviewSchema.parse({ ...forms, slots, ...extra });
  const issues = capabilityReviewFormIssues(review);
  if (issues.length) throw new Error(`Invalid Action review:\n- ${issues.join("\n- ")}`);
  return review;
};
export const capabilityReviewRememberScope = (
  review: CapabilityActionReviewData,
  approval: "rememberable" | "none" | undefined,
): string | undefined =>
  approval !== "rememberable"
    ? undefined
    : "sentence" in review
      ? review.ask === undefined
        ? review.scope
        : undefined
      : review.approvalScope;

type Detail = NonNullable<CapabilityActionLegacyReview["details"]>[number];
/** Today's surfaces read this view; storage and digests always retain the original review. */
export const capabilityReviewView = (
  review: CapabilityActionReviewData,
  context: { timeZone: string },
): Pick<CapabilityActionLegacyReview, "message" | "details" | "links"> => {
  if (!("sentence" in review)) return review;
  const de = review.locale.toLowerCase().startsWith("de");
  const details: Detail[] = [];
  const row = (en: string, german: string, value: string | number | boolean | undefined, format?: Detail["format"], block = false) => {
    if (value !== undefined)
      details.push({
        label: de ? german : en,
        value: String(value),
        ...(format ? { format } : {}),
        ...(block ? { display: "block" as const } : {}),
      });
  };
  const people = (en: string, german: string, persons: Parameters<typeof capabilityPersonText>[0][] | undefined, more = 0) => {
    if (persons === undefined && !more) return;
    const values = (persons ?? []).map(capabilityPersonText);
    if (more) values.push(de ? `und ${more} weitere` : `and ${more} more`);
    row(en, german, values.join(", "));
  };
  const sentence = (value: { text: string; slots?: Readonly<Record<string, CapabilitySlot>> }) =>
    capabilitySentenceText(value.text, value.slots ?? {}, { locale: review.locale, timeZone: context.timeZone });
  const consequence = (value: NonNullable<CapabilityActionReview["consequences"]>[number]) =>
    row(
      value.mark === "added" ? "Added" : value.mark === "removed" ? "Removed" : "Consequence",
      value.mark === "added" ? "Neu" : value.mark === "removed" ? "Entfernt" : "Folge",
      sentence(value),
    );
  const p = review.preview;
  if (p)
    switch (p.kind) {
      case "message": {
        if (p.from) row("From", "Von", capabilityPersonText(p.from));
        people("To", "An", p.to, p.more?.to);
        people("Cc", "Cc", p.cc, p.more?.cc);
        people("Bcc", "Bcc", p.bcc, p.more?.bcc);
        row("Subject", "Betreff", p.subject);
        const attachments = (p.attachments ?? []).map((a) => `${a.name}${a.size === undefined ? "" : ` (${a.size} B)`}`);
        if (p.moreAttachments) attachments.push(de ? `und ${p.moreAttachments} weitere` : `and ${p.moreAttachments} more`);
        if (p.attachments || p.moreAttachments) row("Attachments", "Anhänge", attachments.join(", "));
        row("Send at", "Sendezeit", p.sendAt, "date-time");
        for (const warning of p.warnings ?? []) row("Warning", "Warnung", warning);
        row("Body", "Text", p.body, p.format === "markdown" ? "markdown" : undefined, true);
        break;
      }
      case "event":
        row("Title", "Titel", p.title);
        row("Start", "Beginn", p.start, p.allDay || p.start.length === 10 ? "date" : "date-time");
        row("End", "Ende", p.end, p.allDay || p.end?.length === 10 ? "date" : "date-time");
        row("All day", "Ganztägig", p.allDay === undefined ? undefined : p.allDay ? (de ? "Ja" : "Yes") : de ? "Nein" : "No");
        row("Time zone", "Zeitzone", p.timeZone);
        row("Place", "Ort", p.place);
        row("Location", "Adresse", p.location);
        row("Recurrence", "Wiederholung", p.recurrence);
        people("Attendees", "Teilnehmende", p.attendees);
        row("Description", "Beschreibung", p.description, undefined, true);
        break;
      case "task":
        row("Title", "Titel", p.title);
        row("Place", "Ort", p.place);
        row("Due", "Fällig", p.due, p.due?.length === 10 ? "date" : "date-time");
        people("Assignees", "Zuständig", p.assignees);
        row("Status", "Status", p.status);
        for (const item of p.checklist ?? []) row(item.done ? "Done" : "Open", item.done ? "Erledigt" : "Offen", item.label);
        if (p.tags) row("Tags", "Tags", p.tags.join(", "));
        row("Description", "Beschreibung", p.description, undefined, true);
        break;
      case "page":
        row("Title", "Titel", p.title);
        row("Place", "Ort", p.place);
        row("Body", "Text", p.body, p.format === "markdown" ? "markdown" : undefined, true);
        for (const change of p.changes ?? [])
          row(
            change.change === "added" ? "Added" : "Removed",
            change.change === "added" ? "Neu" : "Entfernt",
            change.text,
            undefined,
            true,
          );
        break;
      case "file":
        row("Name", "Name", p.name);
        row("Place", "Ort", p.place);
        row("Path", "Pfad", p.path);
        row("Size", "Größe", p.size);
        row("Media type", "Medientyp", p.mediaType);
        row("To", "Ziel", p.to);
        break;
      case "rule":
        row("When", "Wenn", sentence(p.when));
        row("Does", "Tut", p.does, undefined, true);
        for (const right of p.may) consequence(right);
        row("Sees this chat", "Kennt diesen Chat", p.seesChat ? (de ? "Ja" : "Yes") : de ? "Nein" : "No");
        break;
      case "fields":
        for (const field of p.rows) {
          row(field.label, field.label, field.value, field.format);
          if (field.before !== undefined) row(`${field.label} (before)`, `${field.label} (vorher)`, field.before, field.format);
        }
        break;
    }
  for (const value of review.consequences ?? []) consequence(value);
  return {
    message: capabilitySentenceText(review.sentence.action, review.slots, { locale: review.locale, timeZone: context.timeZone }),
    ...(details.length ? { details } : {}),
    ...(review.links ? { links: review.links } : {}),
  };
};
