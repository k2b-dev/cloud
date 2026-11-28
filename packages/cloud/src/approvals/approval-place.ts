import { createContext, type JSX } from "solid-js";
import type { ApprovalFrameProps } from "./ApprovalFrame";

/**
 * Where an approval stands in a v2 page. A list built with `@k2b/ui/v2` provides it around each approval, with the
 * frame that draws it there; `ApprovalFrame` then hands its props to that frame. Places without it (the chat, the side
 * panel) keep the v1 frame and never load v2.
 */
export type ApprovalPlace = {
  /** The reader's locale, for the time of the request. */
  locale: string;
  /** Where the request waits, in words, and its page. */
  origin: { text: string; href: string };
  /** The automation that started it, if any. */
  automation?: { text: string; href: string };
  createdAt: string;
  /** Draws the approval in this place. */
  frame: (props: ApprovalFrameProps) => JSX.Element;
};

export const ApprovalPlaceContext = createContext<ApprovalPlace>();

/** A click meant for the page must not approve a row that just appeared: decision buttons arm after this delay. */
export const ARM_DELAY_MS = 500;
