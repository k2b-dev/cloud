import {
  type CapabilitySentencePart,
  capabilityAskReasonText,
  capabilityQuestionText,
  capabilityReceiptParts,
  capabilityReviewSentence,
  capabilityReviewSentenceParts,
  capabilitySentenceText,
} from "../../_internal/capability-sentences";
import type {
  CapabilityActionCallReview,
  CapabilityActionReceipt,
  CapabilityActionReview,
  CapabilityAskReason,
  CapabilityConsequence,
  CapabilityPreview,
  CapabilitySemanticLink,
  CapabilitySlot,
} from "../../contracts/capabilities";
import { cloudResourceHref } from "../../contracts/resource-href";
import {
  type AiLegacyReviewRow,
  type AiStoredActionReview,
  isLegacyActionReview,
  legacyActionReview,
  storedActionReview,
} from "../action-review";
import type { AiTurnBlock } from "../protocol";
import { toolSubject } from "../tool-wording";
import { actionMessages } from "./action-messages";
import { aiToolIcon, displayToolName } from "./message-utils";
import { aiChatMessages } from "./messages";

/**
 * One Action question and its outcome lines as data, the same for the chat, the approvals page, and Code Mode. A new
 * review gives the app's sentence with typed chips, its preview, and its buttons; an older review is shown as its
 * literal text. Pure, so the server render and the first browser render agree.
 */

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

export type ActionChip =
  | { kind: "object" | "place"; title: string; href?: string; icon?: string; gone?: boolean }
  | { kind: "person"; names: string[]; rest: number; more: string; locale: string }
  | { kind: "time"; label: string; dateTime: string };
export type ActionTextPart = { kind: "text"; text: string } | { kind: "chip"; chip: ActionChip };
/** A sentence as text and chips. */
export type ActionText = ActionTextPart[];

export type ActionReason = { code: CapabilityAskReason; text: string; icon: string; tone: "neutral" | "danger" | "warning" };

export type ActionPreviewModel =
  | {
      kind: "review";
      locale: string;
      timeZone: string;
      preview?: CapabilityPreview;
      consequences: { text: ActionText; mark?: "added" | "removed" }[];
      /** The rule sentence of a `rule` preview, with its chips. */
      when?: ActionText;
      /** Each `may` line of a `rule` preview. */
      may?: { text: ActionText; mark?: "added" | "removed" }[];
    }
  | { kind: "legacy"; rows: AiLegacyReviewRow[]; markdown?: string; input?: unknown };

export type ActionCard = {
  /** The language of the question; Cloud's words on the card use it too, so one card never mixes languages. */
  locale: string;
  app: { name: string; icon: string; accent?: string };
  question: ActionText;
  /** The plain question, for the accessible name of places that only list it. */
  questionText: string;
  reason: ActionReason;
  preview: ActionPreviewModel | null;
  /** Opens exactly this version of the thing. */
  readMore?: string;
  /** The review's other links, such as editing the draft, each with its words. */
  links: { href: string; label: string }[];
  /** Where the thing itself opens, for an outcome Cloud could not see. */
  open?: string;
  confirm: { label: string; variant: "ai" | "danger" };
  decline: string;
  forms: {
    running: ActionText;
    done: ActionText;
    rejected: ActionText;
    notRun: ActionText;
    unknown: ActionText;
    unknownStill: ActionText;
  };
  /** The thing the question is about, for "Your answer about … didn't arrive". */
  subject: ActionText;
  /** One short plain sentence, for a message that asks the Assistant again. */
  short: string;
  /** The app can settle an unknown outcome with its `check` Query. */
  hasCheck: boolean;
  /** The receipt text of an old review's success summary. */
  summary?: string;
};

const REASON_LOOK: Record<CapabilityAskReason, Omit<ActionReason, "code" | "text">> = {
  sends: { icon: "ti ti-world", tone: "neutral" },
  deletes: { icon: "ti ti-alert-triangle", tone: "danger" },
  cannot_undo: { icon: "ti ti-alert-triangle", tone: "danger" },
  involves_people: { icon: "ti ti-users-group", tone: "neutral" },
  changes_access: { icon: "ti ti-users", tone: "neutral" },
  keeps_working: { icon: "ti ti-bolt", tone: "neutral" },
  sensitive: { icon: "ti ti-lock", tone: "neutral" },
  app_asks: { icon: "ti ti-info-circle", tone: "neutral" },
};

export const actionReason = (code: CapabilityAskReason, context: { locale: string; appName: string }): ActionReason => ({
  code,
  text: capabilityAskReasonText(code, context),
  ...REASON_LOOK[code],
});

export type ActionCardContext = { locale: string; timeZone: string; app: { name: string; icon: string; accent?: string } };

const textPart = (text: string): ActionTextPart => ({ kind: "text", text });
const plainText = (text: string): ActionText => [textPart(text)];

/** Merges neighbouring text parts, so a sentence never splits a word between two text nodes. */
const merge = (parts: ActionText): ActionText =>
  parts.reduce<ActionText>((all, part) => {
    const last = all.at(-1);
    if (part.kind === "text" && last?.kind === "text") all[all.length - 1] = textPart(last.text + part.text);
    else if (part.kind !== "text" || part.text) all.push(part);
    return all;
  }, []);

const chipOf = (slot: CapabilitySlot, label: string, locale: string, app: ActionCardContext["app"]): ActionChip | null => {
  switch (slot.kind) {
    case "object":
    case "place":
      return {
        kind: slot.kind,
        title: slot.title,
        ...(slot.ref && !(slot.kind === "object" && slot.gone) ? { href: cloudResourceHref(slot.ref) } : {}),
        icon: slot.icon ?? app.icon,
        ...(slot.kind === "object" && slot.gone ? { gone: true } : {}),
      };
    case "person": {
      const shown = slot.people.slice(0, 3).map((person) => person.name ?? person.address ?? "");
      const rest = Math.max(0, (slot.total ?? slot.people.length) - shown.length);
      return { kind: "person", names: shown, rest, more: rest > 0 ? actionMessages(locale).moreCount({ count: rest }) : "", locale };
    }
    case "time":
      return { kind: "time", label, dateTime: slot.start };
    default:
      return null;
  }
};

const partsText = (parts: CapabilitySentencePart[], locale: string, app: ActionCardContext["app"]): ActionText =>
  merge(
    parts.map((part) => {
      if (part.kind === "text") return textPart(part.text);
      // The full label: the chip cuts it for the eye and keeps it whole as its name and tooltip.
      const chip = chipOf(part.slot, part.full, locale, app);
      return chip ? { kind: "chip" as const, chip } : textPart(part.label);
    }),
  );

/** The plain words of a sentence, as a screen reader or a message reads them. */
export const actionPlainText = (text: ActionText): string =>
  text
    .map((part) => {
      if (part.kind === "text") return part.text;
      const chip = part.chip;
      if (chip.kind === "person")
        return new Intl.ListFormat(chip.locale, { type: "conjunction" }).format(chip.rest > 0 ? [...chip.names, chip.more] : chip.names);
      return chip.kind === "time" ? chip.label : chip.title;
    })
    .join("");

const firstLink = (links: readonly CapabilitySemanticLink[] | undefined, rels: CapabilitySemanticLink["rel"][]) =>
  rels.map((rel) => links?.find((link) => link.rel === rel)?.href).find(Boolean);

/** Every link but the one "Read it all" follows, named by its own title or by what it does in the app. */
const otherLinks = (links: readonly CapabilitySemanticLink[] | undefined, locale: string, app: string) => {
  const readMore = firstLink(links, ["open", "preview"]);
  const t = aiChatMessages(locale);
  const label = (link: CapabilitySemanticLink) =>
    link.title ??
    { open: t.openIn({ app }), edit: t.editIn({ app }), status: t.statusIn({ app }), preview: t.preview, download: t.download }[link.rel];
  return (links ?? []).filter((link) => link.href !== readMore).map((link) => ({ href: link.href, label: label(link) }));
};

const firstObjectHref = (review: CapabilityActionCallReview): string | undefined =>
  Object.values(review.slots)
    .map((slot) => ((slot.kind === "object" || slot.kind === "place") && slot.ref ? cloudResourceHref(slot.ref) : undefined))
    .find(Boolean);

export const reviewActionCard = (review: CapabilityActionCallReview, context: ActionCardContext): ActionCard => {
  const locale = review.locale;
  const tz = { timeZone: context.timeZone };
  const parts = (form: Parameters<typeof capabilityReviewSentenceParts>[1]) =>
    partsText(capabilityReviewSentenceParts(review, form, tz), locale, context.app);
  const sentence = (text: string, slots: CapabilityActionCallReview["slots"] | undefined) =>
    partsText(
      // A consequence or rule sentence uses its own slots, else the review's.
      capabilityReceiptParts({ text, slots: slots ?? review.slots }, { locale, timeZone: context.timeZone }),
      locale,
      context.app,
    );
  const consequence = (entry: CapabilityConsequence) => ({
    text: sentence(entry.text, entry.slots),
    ...(entry.mark ? { mark: entry.mark } : {}),
  });
  const code = review.ask ?? "app_asks";
  const subjectSlot = Object.entries(review.slots).find(([, slot]) => slot.kind === "object" || slot.kind === "place");
  const preview = review.preview;
  return {
    locale,
    app: context.app,
    question: parts("question"),
    questionText: capabilityReviewSentence(review, "question", tz),
    reason: actionReason(code, { locale, appName: context.app.name }),
    preview:
      preview || review.consequences?.length
        ? {
            kind: "review",
            locale,
            timeZone: context.timeZone,
            ...(preview ? { preview } : {}),
            consequences: (review.consequences ?? []).map(consequence),
            ...(preview?.kind === "rule"
              ? { when: sentence(preview.when.text, preview.when.slots), may: preview.may.map(consequence) }
              : {}),
          }
        : null,
    readMore: firstLink(review.links, ["open", "preview"]),
    links: otherLinks(review.links, locale, context.app.name),
    open: firstLink(review.links, ["open", "edit", "status"]) ?? firstObjectHref(review),
    confirm: {
      label: capabilityReviewSentence(review, "confirm", tz),
      variant: code === "deletes" || code === "cannot_undo" ? "danger" : "ai",
    },
    decline: capabilityReviewSentence(review, "decline", tz),
    forms: {
      running: parts("running"),
      done: parts("done"),
      rejected: parts("rejected"),
      notRun: parts("notRun"),
      unknown: parts("unknown"),
      unknownStill: parts("unknownStill"),
    },
    subject: subjectSlot
      ? partsText(
          capabilityReviewSentenceParts({ ...review, sentence: { ...review.sentence, done: `{${subjectSlot[0]}}` } }, "done", tz),
          locale,
          context.app,
        )
      : plainText(context.app.name),
    short: capabilityReviewSentence(review, "short", tz),
    hasCheck: Boolean(review.check),
  };
};

/**
 * An old review, or a call without one, as literal text: the question is the old message (or Cloud's sentence for the
 * call), its details are rows. Its outcome lines use Cloud's frames around that sentence.
 */
export type LegacyCardInput = {
  question: string;
  rows: AiLegacyReviewRow[];
  markdown?: string;
  links?: readonly CapabilitySemanticLink[];
  summary?: string;
  /** The subject of the outcome lines, such as the app's sentence for the call. */
  subject: string;
  /** The answer's words: the Action's title. */
  title: string;
  outcome: { running: string; done: string; rejected: string; notRun: string; unknown: string; unknownStill: string };
  /** The call's own input, shown on demand when the question has nothing else to show. */
  input?: unknown;
};

export const legacyActionCard = (input: LegacyCardInput, context: ActionCardContext): ActionCard => {
  const t = actionMessages(context.locale);
  const showInput = input.rows.length === 0 && !input.markdown && input.input !== undefined;
  return {
    locale: context.locale,
    app: context.app,
    question: plainText(input.question),
    questionText: input.question,
    reason: actionReason("app_asks", { locale: context.locale, appName: context.app.name }),
    preview:
      input.rows.length > 0 || input.markdown || showInput
        ? {
            kind: "legacy",
            rows: input.rows,
            ...(input.markdown ? { markdown: input.markdown } : {}),
            ...(showInput ? { input: input.input } : {}),
          }
        : null,
    readMore: firstLink(input.links, ["open", "preview"]),
    links: otherLinks(input.links, context.locale, context.app.name),
    open: firstLink(input.links, ["open", "edit", "status"]),
    confirm: { label: input.title, variant: "ai" },
    decline: t.decline,
    forms: {
      running: plainText(input.outcome.running),
      done: plainText(input.summary ?? input.outcome.done),
      rejected: plainText(input.outcome.rejected),
      notRun: plainText(input.outcome.notRun),
      unknown: plainText(input.outcome.unknown),
      unknownStill: plainText(input.outcome.unknownStill),
    },
    subject: plainText(input.subject),
    short: input.subject,
    hasCheck: false,
    ...(input.summary ? { summary: input.summary } : {}),
  };
};

/** The receipt an Action returned, or the result of its `check`, as a sentence in the review's language. */
export const actionReceiptText = (receipt: CapabilityActionReceipt, card: ActionCard, timeZone: string): ActionText =>
  partsText(capabilityReceiptParts(receipt, { locale: card.locale, timeZone }), card.locale, card.app);

// ---------------------------------------------------------------------------
// Tool blocks
// ---------------------------------------------------------------------------

/** The review of a call: the one Cloud stored, else the one its open approval carries. */
export const toolBlockReview = (block: ToolBlock): AiStoredActionReview | null =>
  block.review ?? (block.approval?.review ? storedActionReview(block.approval.review) : null);

/**
 * The lines an approval message adds for a Cloud tool, such as "HTTP request: GET https://…": the first line naming
 * the app and the call repeats the question, and the generic hint says nothing.
 */
const messageRows = (block: ToolBlock): AiLegacyReviewRow[] => {
  const message = block.approval?.message?.trim();
  if (!message || block.presentation?.kind === "capability") return [];
  const rows: AiLegacyReviewRow[] = [];
  // "Label: value" is one row; "Label:" alone starts a row whose value is the lines after it.
  let open: AiLegacyReviewRow | null = null;
  for (const line of message.split("\n").map((entry) => entry.trim())) {
    if (!line || /^Review the validated arguments below before running this action\.$/i.test(line)) continue;
    const heading = /^([^:]{1,40}):$/.exec(line);
    const match = /^([^:]{1,40}):\s+(.+)$/.exec(line);
    if (heading) {
      open = { label: heading[1]!, value: "" };
      rows.push(open);
    } else if (match) {
      open = null;
      rows.push({ label: match[1]!, value: match[2]! });
    } else if (open) open.value = open.value ? `${open.value}\n${line}` : line;
    else rows.push({ label: "", value: line });
  }
  return rows;
};

export type ToolOutcomeWords = LegacyCardInput["outcome"];

/** The card for one tool block, in the reader's locale unless its review names another. */
export const toolActionCard = (
  block: ToolBlock,
  context: { locale: string; timeZone: string; outcome: (subject: string) => ToolOutcomeWords },
): ActionCard => {
  const presentation = block.presentation;
  const app = {
    name: presentation?.appName ?? "Cloud",
    icon: aiToolIcon(block.name, presentation?.appIcon),
    ...(presentation?.appAccent ? { accent: presentation.appAccent } : {}),
  };
  const cardContext = { locale: context.locale, timeZone: context.timeZone, app };
  const review = toolBlockReview(block);
  if (review && !isLegacyActionReview(review)) return reviewActionCard(review, cardContext);
  const subject =
    toolSubject(block, context.locale, context.timeZone) ?? presentation?.title ?? displayToolName(block.name, context.locale);
  const title = presentation?.title ?? subject;
  const legacy = review?.legacy;
  return legacyActionCard(
    {
      // An old review's message stays literal; Cloud's own sentence for the call is asked as a question.
      question: legacy?.question ?? capabilityQuestionText(subject, context.locale),
      rows: legacy?.rows ?? messageRows(block),
      ...(legacy?.markdown ? { markdown: legacy.markdown } : {}),
      ...(legacy?.links ? { links: legacy.links } : {}),
      ...(legacy?.summary ? { summary: legacy.summary } : {}),
      subject,
      title,
      outcome: context.outcome(subject),
      input: block.args,
    },
    cardContext,
  );
};

/** An old review read from a pending approval, the same way the chat stores it. */
export const legacyReviewOf = (review: CapabilityActionReview) => legacyActionReview(review).legacy;

/** The action sentence of a review as plain text, without the question mark. */
export const reviewActionText = (review: CapabilityActionCallReview, timeZone: string): string =>
  capabilitySentenceText(review.sentence.action, review.slots, { locale: review.locale, timeZone });
