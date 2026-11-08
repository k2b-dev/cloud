import { capabilityReviewSentence, capabilitySentenceText } from "../_internal/capability-sentences";
import { bindView } from "../blocks/bind";
import { findDraft } from "../blocks/bound";
import { blocksText } from "../blocks/text";
import {
  CAPABILITY_MAX_REVIEW_BYTES,
  type CapabilityActionCallReview,
  CapabilityActionCallReviewSchema,
  type CapabilityActionReview,
  type CapabilityActionReviewData,
  type CapabilitySlot,
} from "../contracts/capabilities";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES } from "../contracts/capability-limits";
import { canonicalLocale } from "../shared/locale";
export const reviewDraft = findDraft;
// Optional review forms may be explicitly undefined in in-process producers. Their
// JSON representation omits them; use that same representation for data binding.
export const reviewBindingData = (review: CapabilityActionCallReview) => ({
  ...Object.fromEntries(Object.entries(review).filter(([, value]) => value !== undefined)),
  sentence: Object.fromEntries(Object.entries(review.sentence).filter(([, value]) => value !== undefined)),
});
export const boundReviewView = (review: CapabilityActionCallReview) =>
  review.view
    ? bindView(review.view, reviewBindingData(review), { maxBytes: CAPABILITY_MAX_REVIEW_CONTENT_BYTES + CAPABILITY_MAX_REVIEW_BYTES + 11 })
    : undefined;

/** Context-free rules shared by the builder and runtime validation. */
export const capabilityReviewFormIssues = (review: CapabilityActionCallReview): string[] => {
  const issues: string[] = [];
  if (canonicalLocale(review.locale) !== review.locale) return ["locale must be a canonical BCP 47 tag"];
  for (const form of ["confirm", "decline"] as const)
    if (Array.from(capabilityReviewSentence(review, form, { timeZone: "UTC" })).length > 40)
      issues.push(`${form} exceeds 40 rendered characters`);
  let draft: ReturnType<typeof reviewDraft>;
  try {
    draft = reviewDraft(boundReviewView(review)?.blocks);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Invalid review view");
  }
  if (
    review.ask === "sends" &&
    draft &&
    !draft.context?.some((row) => /^(from|von)$/iu.test(row.label) && (typeof row.value === "string" ? row.value.trim() : row.value.length))
  )
    issues.push("A sends Draft requires sender context (From/Von)");
  try {
    const { view: _view, ...compact } = review;
    if (new TextEncoder().encode(JSON.stringify(compact)).byteLength > CAPABILITY_MAX_REVIEW_BYTES) issues.push("Review exceeds 32 KiB");
  } catch {
    issues.push("Review is not JSON serializable");
  }
  return issues;
};
export type CapabilityReviewForms = Pick<CapabilityActionCallReview, "locale" | "sentence">;
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
  extra?: Omit<CapabilityActionCallReview, "locale" | "sentence" | "slots">,
): CapabilityActionCallReview => {
  const review = CapabilityActionCallReviewSchema.parse({ ...forms, slots, ...extra });
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

type Detail = NonNullable<CapabilityActionReview["details"]>[number];
/** Today's surfaces read this view; storage and digests always retain the original review. */
export const capabilityReviewView = (
  review: CapabilityActionReviewData,
  context: { timeZone: string },
): Pick<CapabilityActionReview, "message" | "details" | "links"> => {
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
  const sentence = (value: { text: string; slots?: Readonly<Record<string, CapabilitySlot>> }) =>
    capabilitySentenceText(value.text, value.slots ?? {}, { locale: review.locale, timeZone: context.timeZone });
  const consequence = (value: NonNullable<CapabilityActionCallReview["consequences"]>[number]) =>
    row(
      value.mark === "added" ? "Added" : value.mark === "removed" ? "Removed" : "Consequence",
      value.mark === "added" ? "Neu" : value.mark === "removed" ? "Entfernt" : "Folge",
      sentence(value),
    );
  const view = boundReviewView(review);
  if (view) row("Details", "Details", blocksText(view.blocks, { locale: review.locale, timeZone: context.timeZone }), undefined, true);
  for (const value of review.consequences ?? []) consequence(value);
  return {
    message: capabilitySentenceText(review.sentence.action, review.slots, { locale: review.locale, timeZone: context.timeZone }),
    ...(details.length ? { details } : {}),
    ...(review.links ? { links: review.links } : {}),
  };
};
