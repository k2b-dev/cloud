import type { IntentTone } from "../semantics";

// The class names and tones of `NoticeCard`, apart from the component: Markdown's info blocks write the same markup as
// a string, and a module with components would bring them along into every bundle that needs only the names.

export type NoticeTone = Extract<IntentTone, "neutral" | "info" | "success" | "warning" | "danger"> | "ai";

export const NOTICE_CARD_CLASSES = {
  root: "k2b-notice-card",
  icon: "k2b-notice-card__icon",
  content: "k2b-notice-card__content",
  head: "k2b-notice-card__head",
  title: "k2b-notice-card__title",
  meta: "k2b-notice-card__meta",
  description: "k2b-notice-card__description",
  body: "k2b-notice-card__body",
  actions: "k2b-notice-card__actions",
} as const;
