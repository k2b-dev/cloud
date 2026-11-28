import { useUiMessages } from "../intl/messages";
import { Icon } from "./icon";

// The error fallback of every island is this state, so its module loads only what it draws: the sign, the sentence and
// the button, without the button module, the marks and the other states. A module that every island shares is in
// the common chunk of an app, and Bun keeps there what any island uses of it (#4292): `Loading`, a mark or a chip of
// one app would land in every island.

export type FailedProps = {
  /**
   * What could not be loaded and what stays as it is, in one or two sentences. Example: "Unterhaltungen konnten nicht
   * geladen werden. Deine Ansicht und Auswahl bleiben erhalten."
   */
  text: string;
  /** Loads again; the button says "Erneut versuchen" in the language of the page. */
  onRetry: () => void;
};

/**
 * Loading failed: the shape of `Empty` with a sign in the tone of wrong, the sentence, and "Erneut versuchen". It
 * replaces only the data; the selection and the view around it stay. (A connection that retries on its own shows in
 * the status row instead, without a button; something a person must fix is a `Notice` that names the deed.)
 */
export const Failed = (props: FailedProps) => {
  const t = useUiMessages();
  let root: HTMLDivElement | undefined;
  return (
    <div ref={root} class="k2-state" data-k2-part="Failed" role="alert">
      <span class="k2-sign" data-tone="bad">
        <Icon name="alert-circle" />
      </span>
      <span class="k2-state-text">{props.text}</span>
      {/* the markup of a `Button` with its icon and words, written out: the button module would bring the marks */}
      <button
        type="button"
        class="k2-btn"
        data-k2-part="Button"
        onClick={() => {
          // the focus is on the button, which leaves with this state: it goes on to what comes in its place
          if (root?.contains(document.activeElement)) focusWhatComes(root);
          props.onRetry();
        }}
      >
        <Icon name="refresh" />
        <span class="k2-btn-label">{t().retry}</span>
      </button>
    </div>
  );
};

const focusable = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";

/**
 * Gives the focus to the first visible thing that can take it among what replaces `state` in its place, such as the
 * first row of the list that loaded. It waits while placeholders stand there, and stops once it has placed the
 * focus, once the person focuses something themselves, or once the content has come without anything to focus.
 */
const focusWhatComes = (state: HTMLElement) => {
  const place = state.parentElement;
  if (!place || typeof MutationObserver === "undefined") return;
  const before = state.previousSibling;
  const after = state.nextSibling;
  const follows = (node: Node, anchor: Node | null) =>
    !anchor?.isConnected || !!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  const precedes = (node: Node, anchor: Node | null) =>
    !anchor?.isConnected || !!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
  const inPlace = (node: Node) => follows(node, before) && precedes(node, after) && !state.contains(node);
  const stop = () => {
    observer.disconnect();
    document.removeEventListener("focusin", stop);
  };
  const settle = () => {
    const target = [...place.querySelectorAll<HTMLElement>(focusable)].find(
      (element) => inPlace(element) && element.tabIndex >= 0 && element.getClientRects().length > 0,
    );
    if (target) {
      stop();
      target.focus();
      return;
    }
    const waiting = [...place.querySelectorAll('[data-k2-part="Loading"], [aria-busy="true"]')].some(inPlace);
    if (!state.isConnected && !waiting) stop();
  };
  const observer = new MutationObserver(settle);
  observer.observe(place, { childList: true, subtree: true });
  document.addEventListener("focusin", stop);
};
