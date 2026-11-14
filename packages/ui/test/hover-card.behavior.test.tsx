import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/** happy-dom has no Popover API; model the open state on the element. */
const installPopover = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const matches = prototype.matches;
  prototype.showPopover = function (this: HTMLElement) {
    this.dataset.testPopoverOpen = "true";
  };
  prototype.hidePopover = function (this: HTMLElement) {
    delete this.dataset.testPopoverOpen;
  };
  // `matches` declares type-predicate overloads; the stub only answers the runtime string form.
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? this.dataset.testPopoverOpen === "true" : matches.call(this, selector);
    },
  });
};

const pointer = (dom: DomTestHarness, target: Element, type: string, pointerType: "mouse" | "touch" = "mouse") =>
  target.dispatchEvent(new dom.window.PointerEvent(type, { pointerType, bubbles: type === "pointerdown" }) as unknown as Event);
const key = (dom: DomTestHarness, target: Element, value: string) =>
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }) as unknown as Event);
const isOpen = (card: Element | null) => card?.matches(":popover-open") ?? false;

describe("HoverCard", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }

  let dom: DomTestHarness;
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-11-14T09:00:00Z") });
    dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    installPopover(dom);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    dom.cleanup();
    jest.useRealTimers();
  });

  /** Components are imported after the document exists. */
  const mountAnchor = async () => {
    const { HoverCard } = await import("../src/feedback/HoverCard");
    dispose = render(
      () => (
        <HoverCard title="Shelf R4 › Bin 7" detail="Return stack 1 of Lea Lorem" content={<p>22 items since Nov 9</p>}>
          <a href="#bin-7" aria-describedby="existing">
            R4 › Bin 7
          </a>
        </HoverCard>
      ),
      dom.root,
    );
    const anchor = dom.root.querySelector<HTMLElement>(".k2b-hover-card-anchor")!;
    const link = dom.root.querySelector<HTMLAnchorElement>("a")!;
    const card = dom.root.querySelector<HTMLElement>(".k2b-hover-card")!;
    return { anchor, link, card };
  };

  test("opens after the delay of a resting mouse, never at once, and describes the focusable control", async () => {
    const { anchor, link, card } = await mountAnchor();
    expect(card.getAttribute("role")).toBe("tooltip");
    // The card joins the control's own description; its role and name stay.
    expect(link.getAttribute("aria-describedby")).toBe(`existing ${card.id}`);
    expect(card.textContent).toContain("22 items since Nov 9");

    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(399);
    expect(isOpen(card)).toBe(false);
    jest.advanceTimersByTime(1);
    expect(isOpen(card)).toBe(true);

    // A pass over the control that leaves before the delay opens nothing.
    pointer(dom, anchor, "pointerleave");
    jest.advanceTimersByTime(200);
    expect(isOpen(card)).toBe(false);
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(200);
    pointer(dom, anchor, "pointerleave");
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(false);
  });

  test("stays open while the pointer moves from the control onto the card and closes once it left both", async () => {
    const { anchor, card } = await mountAnchor();
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(400);
    expect(isOpen(card)).toBe(true);

    pointer(dom, anchor, "pointerleave");
    jest.advanceTimersByTime(150);
    pointer(dom, card, "pointerenter");
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(true);

    // Back on the control and onto the card again: still open.
    pointer(dom, card, "pointerleave");
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(true);

    pointer(dom, anchor, "pointerleave");
    jest.advanceTimersByTime(199);
    expect(isOpen(card)).toBe(true);
    jest.advanceTimersByTime(1);
    expect(isOpen(card)).toBe(false);
  });

  test("opens at once on keyboard focus, closes on blur, and never on focus from a press", async () => {
    const { link, card } = await mountAnchor();
    // Focus without a ring, as after a click, opens nothing.
    link.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    expect(isOpen(card)).toBe(false);

    link.focus();
    expect(link.matches(":focus-visible")).toBe(true);
    expect(isOpen(card)).toBe(true);

    link.blur();
    expect(isOpen(card)).toBe(false);
  });

  test("Escape closes the card until the pointer left the control", async () => {
    const { anchor, card } = await mountAnchor();
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(400);
    expect(isOpen(card)).toBe(true);

    key(dom, dom.document.body, "Escape");
    expect(isOpen(card)).toBe(false);
    // Resting on, it stays closed.
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(false);

    pointer(dom, anchor, "pointerleave");
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(400);
    expect(isOpen(card)).toBe(true);
  });

  test("using the wrapped control closes the card, and touch keeps the control's own tap", async () => {
    const { anchor, link, card } = await mountAnchor();
    pointer(dom, anchor, "pointerenter");
    jest.advanceTimersByTime(400);
    pointer(dom, link, "pointerdown");
    expect(isOpen(card)).toBe(false);

    pointer(dom, anchor, "pointerleave");
    pointer(dom, anchor, "pointerenter", "touch");
    pointer(dom, link, "pointerdown", "touch");
    link.click();
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(false);
  });

  test("a trigger toggles a pinned card with a press, which outlasts the pointer and closes on a press outside", async () => {
    const { HoverCard } = await import("../src/feedback/HoverCard");
    dispose = render(
      () => (
        <>
          <HoverCard.Trigger aria-label="Path of B7A02" content={<p>Received on Nov 7</p>}>
            <span>path</span>
          </HoverCard.Trigger>
          <button type="button" id="elsewhere">
            Elsewhere
          </button>
        </>
      ),
      dom.root,
    );
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-hover-card-trigger")!;
    const card = dom.root.querySelector<HTMLElement>(".k2b-hover-card")!;
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-label")).toBe("Path of B7A02");
    expect(trigger.getAttribute("aria-describedby")).toBe(card.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    pointer(dom, trigger, "pointerdown", "touch");
    trigger.click();
    expect(isOpen(card)).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // happy-dom matches no phone media query, so the card stays beside its control.
    expect(card.hasAttribute("data-sheet")).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(true);

    // A second tap closes it.
    pointer(dom, trigger, "pointerdown", "touch");
    trigger.click();
    expect(isOpen(card)).toBe(false);

    // A tap outside closes a pinned card.
    trigger.click();
    expect(isOpen(card)).toBe(true);
    pointer(dom, dom.document.getElementById("elsewhere")!, "pointerdown", "touch");
    expect(isOpen(card)).toBe(false);
  });

  test("a disabled card never opens and an open one closes when it becomes disabled", async () => {
    const { HoverCard } = await import("../src/feedback/HoverCard");
    const { createSignal } = await import("solid-js");
    const [disabled, setDisabled] = createSignal(false);
    dispose = render(
      () => (
        <HoverCard.Trigger content="Details" disabled={disabled()}>
          info
        </HoverCard.Trigger>
      ),
      dom.root,
    );
    const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-hover-card-trigger")!;
    const card = dom.root.querySelector<HTMLElement>(".k2b-hover-card")!;
    pointer(dom, trigger, "pointerenter");
    jest.advanceTimersByTime(400);
    expect(isOpen(card)).toBe(true);
    setDisabled(true);
    expect(isOpen(card)).toBe(false);
    pointer(dom, trigger, "pointerleave");
    pointer(dom, trigger, "pointerenter");
    jest.advanceTimersByTime(1000);
    expect(isOpen(card)).toBe(false);
  });
});
