import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { type Accessor, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { notebookWorkspaceMessages } from "../messages";
import { FULL_WIDTH_PREFERENCE_EVENT } from "./detail/events";
import { readFullWidth, setFullWidth } from "./settings/NotebookSettingsStore";

// Below this width the note is about as narrow as the reading column, so app.css
// hides the switches and the command stays away too.
const WIDE_SCREEN_QUERY = "(min-width: 64rem)";
type ViewMessages = Pick<
  ReturnType<typeof notebookWorkspaceMessages.resolve>["t"],
  "fullWidthOnCommand" | "fullWidthOffCommand" | "fullWidthHint"
>;

/**
 * Saves the personal "Full width" preference in the settings cookie and tells
 * every open reading surface, switch and command, which reread it.
 */
export const changeFullWidth = (fullWidth: boolean) => {
  setFullWidth(fullWidth);
  window.dispatchEvent(new Event(FULL_WIDTH_PREFERENCE_EVENT));
};

/** The preference for a switch: the server's value first, then every change in this page. */
export const createFullWidth = (initial: boolean): Accessor<boolean> => {
  const [fullWidth, setValue] = createSignal(initial);
  onMount(() => {
    const changed = () => setValue(readFullWidth());
    window.addEventListener(FULL_WIDTH_PREFERENCE_EVENT, changed);
    onCleanup(() => window.removeEventListener(FULL_WIDTH_PREFERENCE_EVENT, changed));
  });
  return fullWidth;
};

/**
 * Keeps a reading surface (Write, Read-only or Book) in step with the
 * preference and offers the command that switches it. Call in `onMount`. The
 * server already rendered `data-full-width` on the surface; a change flips it
 * between `keepPosition` and the function it returns, before the next paint,
 * so the text at the top of `scroller` stays in place while the note rewraps.
 */
export const followFullWidth = (scroller: HTMLElement, keepPosition: () => (() => void) | null, t: Accessor<ViewMessages>) => {
  const [fullWidth, setValue] = createSignal(readFullWidth());
  const query = window.matchMedia(WIDE_SCREEN_QUERY);
  const [wide, setWide] = createSignal(query.matches);
  const resized = () => setWide(query.matches);
  const changed = () => {
    const on = readFullWidth();
    const surface = scroller.closest<HTMLElement>(".notebook-document-surface");
    if (!surface || surface.hasAttribute("data-full-width") === on) return;
    const restore = keepPosition();
    surface.toggleAttribute("data-full-width", on);
    restore?.();
    setValue(on);
  };
  query.addEventListener("change", resized);
  window.addEventListener(FULL_WIDTH_PREFERENCE_EVENT, changed);
  onCleanup(() => {
    query.removeEventListener("change", resized);
    window.removeEventListener(FULL_WIDTH_PREFERENCE_EVENT, changed);
  });
  createEffect(() => {
    if (!wide()) return;
    const on = fullWidth();
    onCleanup(
      registerContextAwareCommand({
        id: "notebooks.view.fullWidth",
        title: on ? t().fullWidthOffCommand : t().fullWidthOnCommand,
        description: t().fullWidthHint,
        icon: on ? "ti ti-viewport-narrow" : "ti ti-viewport-wide",
        action: () => changeFullWidth(!on),
      }),
    );
  });
};
