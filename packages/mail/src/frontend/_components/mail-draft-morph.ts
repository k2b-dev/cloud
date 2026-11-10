import { prefersReducedMotion } from "@k2b/ui";

/**
 * The pill grows into the draft, and the draft shrinks back into the pill (Mail concept v4, motion table). State,
 * focus, and layout change at once; afterwards only `clip-path`, `transform`, and `opacity` animate, from the old
 * boxes to the new layout (FLIP). Durations come from the morph tokens, which reduced motion sets to zero.
 */

/** Where things stood before the layout changed. */
export type MailDraftMorphStart = { pill: DOMRect | null; messagesTop: number | null };

const MESSAGES = "[data-mail-conversation-messages]";
const PILL = "[data-mail-reply-pill] .k2b-toolbar";

const token = (element: Element, name: string) => getComputedStyle(element).getPropertyValue(name).trim();
const milliseconds = (value: string) => {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.endsWith("ms") ? amount : value.endsWith("s") ? amount * 1000 : amount;
};

export const captureMailDraftMorph = (root: ParentNode): MailDraftMorphStart => ({
  pill: root.querySelector(PILL)?.getBoundingClientRect() ?? null,
  messagesTop: root.querySelector(MESSAGES)?.getBoundingClientRect().top ?? null,
});

const timing = (element: Element) => {
  const duration = prefersReducedMotion() ? 0 : milliseconds(token(element, "--k2b-motion-morph"));
  return { duration, easing: token(element, "--k2b-ease-morph") || "ease-out" };
};

/** The messages below glide from where they were to their new place. */
const glideMessages = (root: ParentNode, start: MailDraftMorphStart, duration: number, easing: string) => {
  const messages = root.querySelector<HTMLElement>(MESSAGES);
  if (!messages || start.messagesTop === null) return;
  const offset = start.messagesTop - messages.getBoundingClientRect().top;
  if (Math.abs(offset) < 0.5) return;
  messages.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], { duration, easing });
};

/** After the draft took the pill's place: it opens out of the pill's box, its content fades in, the messages glide. */
export const playMailDraftOpen = (root: ParentNode, frame: HTMLElement, start: MailDraftMorphStart) => {
  const { duration, easing } = timing(frame);
  if (duration === 0) return;
  const box = frame.getBoundingClientRect();
  if (start.pill && box.width > 0 && box.height > 0) {
    const inset = [
      Math.max(0, start.pill.top - box.top),
      Math.max(0, box.right - start.pill.right),
      Math.max(0, box.bottom - start.pill.bottom),
      Math.max(0, start.pill.left - box.left),
    ]
      .map((value) => `${value}px`)
      .join(" ");
    frame.animate([{ clipPath: `inset(${inset} round 1.5rem)` }, { clipPath: "inset(0 round 0.875rem)" }], { duration, easing });
    const fade = milliseconds(token(frame, "--k2b-motion-base"));
    const delay = milliseconds(token(frame, "--k2b-motion-fast"));
    for (const child of Array.from(frame.children))
      child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, delay, easing: "ease-out", fill: "backwards" });
  }
  glideMessages(root, start, duration, easing);
};

/** After the pill took the draft's place again: the pill appears and the messages glide up. */
export const playMailDraftClose = (root: ParentNode, start: MailDraftMorphStart) => {
  const pill = root.querySelector<HTMLElement>(PILL);
  const { duration, easing } = timing(pill ?? document.documentElement);
  if (duration === 0) return;
  pill?.animate(
    [
      { opacity: 0, transform: "scale(0.96)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: milliseconds(token(pill, "--k2b-motion-base")), easing: "ease-out" },
  );
  glideMessages(root, start, duration, easing);
};
