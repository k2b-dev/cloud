import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui intl fixture browser parity", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("an island root re-renders with the SSR text through the html lang fallback", async () => {
    const dom = createDomTestHarness();
    // The /intl fixture page emits <html lang> equal to the server provider
    // locale; the island browser root has no provider and must land on the
    // exact same output through this fallback.
    document.documentElement.setAttribute("lang", "de");
    const { default: IntlSection, intlFixtureExpected } = await import("../fixture/src/IntlSection");
    const expected = intlFixtureExpected("de");

    const dispose = render(() => <IntlSection />, dom.root);

    const textOf = (id: string) => dom.root.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect(textOf("intl-locale")).toBe("de");
    expect(textOf("intl-number")).toBe(expected.number);
    expect(textOf("intl-currency")).toBe(expected.currency);
    expect(textOf("intl-percent")).toBe(expected.percent);
    expect(textOf("intl-bytes")).toBe(expected.bytes);
    expect(textOf("intl-date")).toBe(expected.date);
    expect(textOf("intl-time")).toBe(expected.time);
    expect(textOf("intl-datetime")).toBe(expected.dateTime);
    expect(textOf("intl-relative")).toBe(expected.relative);
    expect(textOf("intl-duration")).toBe(expected.duration);
    expect(dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')?.value).toBe(expected.numberInputValue);

    dispose();
    dom.cleanup();
  });
});
