import { createSignal, onCleanup, onMount, Show } from "solid-js";

/**
 * "Bausteine zeigen": while on, hovering a v2 screen outlines the primitive under the pointer and names it with its
 * most important props, read from the DOM contract (`data-k2-part` and the primitive's own data attributes). The
 * outline and the label float in a fixed layer above the page, so nothing in the screen moves.
 *
 * On a screen page of its own the switch floats at the bottom left. Inside the frame of a Fibel demo page the page's
 * own switch (`V2InspectSwitch`) turns it on with a message, so the frame shows no second switch.
 */

/** The data attributes worth naming, in the order they are shown, with how to say them. */
const named: [attribute: string, say: (value: string, element: HTMLElement) => string][] = [
  ["data-place", (value) => `place=${value}`],
  ["data-lines", (value) => `lines=${value}`],
  ["data-avatar", () => "lead=Avatar"],
  ["data-type", (value) => `type=${value}`],
  ["data-variant", (value) => `variant=${value}`],
  ["data-status", (value) => `status=${value}`],
  ["data-kind", (value) => (value === "plain" ? "" : value === "control" ? "onClick" : value)],
  ["data-tone", (value) => `tone=${value}`],
  ["data-name", (value) => `name=${value}`],
  ["data-width", (_value, element) => `width=${getComputedStyle(element).getPropertyValue("--k2-pane-w").trim() || "set"}`],
  ["data-detail", () => "detail"],
  ["data-side", () => "side"],
  ["data-unread", () => "unread"],
  ["data-selected", () => "selected"],
  ["data-yours", () => "yours"],
  ["data-strong", () => "strong"],
  ["data-action", () => "action"],
  ["data-time", () => "time"],
  ["data-meta", () => "meta"],
  ["data-folded", () => "folded"],
  ["data-wrap", () => "wrap"],
  ["data-inline", () => "inline"],
  ["data-icon-only", () => "icon only"],
  ["data-menu", () => "menu"],
  ["data-switch", () => "switch"],
  ["data-title", () => "title"],
];

/** "Row · lines=3 · unread": the name of a primitive and the props its DOM tells. */
export const describePart = (element: HTMLElement): string => {
  const props = named
    .filter(([attribute]) => element.hasAttribute(attribute))
    .map(([attribute, say]) => say(element.getAttribute(attribute) ?? "", element))
    .filter(Boolean);
  return [element.dataset.k2Part ?? "", ...props].join(" · ");
};

type Box = { left: number; top: number; width: number; height: number; label: string };

export const inspectMessage = "k2-inspect";

export default function V2Inspect() {
  const [on, setOn] = createSignal(false);
  const [box, setBox] = createSignal<Box>();
  const [framed, setFramed] = createSignal(false);
  onMount(() => {
    setFramed(window.self !== window.top);
    if (new URLSearchParams(location.search).has("inspect")) setOn(true);
    const move = (event: PointerEvent) => {
      if (!on()) return;
      const part = (event.target as Element | null)?.closest<HTMLElement>("[data-k2-part]");
      if (!part) return setBox(undefined);
      const rect = part.getBoundingClientRect();
      setBox({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, label: describePart(part) });
    };
    const leave = () => setBox(undefined);
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== inspectMessage) return;
      setOn(event.data.on === true);
      if (!on()) setBox(undefined);
    };
    document.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", leave);
    // The layer is fixed; a scroll moves the element under a still pointer, so the box is dropped.
    window.addEventListener("scroll", leave, true);
    window.addEventListener("message", message);
    onCleanup(() => {
      document.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("scroll", leave, true);
      window.removeEventListener("message", message);
    });
  });
  return (
    <>
      <Show when={!framed()}>
        <label class="ui-v2-inspect-toggle" data-floating="">
          <input
            type="checkbox"
            checked={on()}
            onChange={(event) => {
              setOn(event.currentTarget.checked);
              if (!event.currentTarget.checked) setBox(undefined);
            }}
          />
          Bausteine zeigen
        </label>
      </Show>
      <Show when={on() && box()}>
        {(current) => (
          <div class="ui-v2-inspect-layer" aria-hidden="true">
            <div
              class="ui-v2-inspect-box"
              style={{
                left: `${current().left}px`,
                top: `${current().top}px`,
                width: `${current().width}px`,
                height: `${current().height}px`,
              }}
            />
            <div
              class="ui-v2-inspect-label"
              style={{
                left: `${Math.max(0, current().left)}px`,
                top: `${current().top >= 24 ? current().top - 22 : current().top + current().height + 2}px`,
              }}
            >
              {current().label}
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
