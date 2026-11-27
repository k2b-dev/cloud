import { createContext } from "solid-js";

/**
 * A pane tells the head it renders that it holds it: the head of an open thing (`ObjectHead`) calls this while it is
 * made, with the number of its deeds, before the pane writes its attributes, so the pane can shape its phone bar around
 * it on the server already (the deeds stand at the end of that bar, the way back keeps clear of them).
 * A module of its own, so a pane does not carry the head.
 */
export const PaneHeadContext = createContext<(deeds: number) => void>();
