import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui intl browser behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("falls back to html lang in an independent browser root", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "de");
    const { Format, useLocale } = await import("../src/intl");

    const Probe = () => {
      const locale = useLocale();
      return (
        <>
          <output>{locale()}</output>
          <Format.Number value={1234.5} decimals={1} />
        </>
      );
    };
    const dispose = render(() => <Probe />, dom.root);

    expect(dom.root.querySelector("output")?.textContent).toBe("de");
    expect(dom.root.querySelector("span")?.textContent).toBe("1.234,5");

    dispose();
    dom.cleanup();
  });

  test("defaults to en when html lang is empty", async () => {
    const dom = createDomTestHarness();
    document.documentElement.removeAttribute("lang");
    const { Format, useLocale } = await import("../src/intl");

    const Probe = () => {
      const locale = useLocale();
      return (
        <>
          <output>{locale()}</output>
          <Format.Number value={1234.5} decimals={1} />
        </>
      );
    };
    const dispose = render(() => <Probe />, dom.root);

    expect(dom.root.querySelector("output")?.textContent).toBe("en");
    expect(dom.root.querySelector("span")?.textContent).toBe("1,234.5");

    dispose();
    dom.cleanup();
  });

  test("a provider inside the browser root beats html lang, and a prop beats the provider", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "de");
    const { Format, LocaleProvider } = await import("../src/intl");

    const dispose = render(
      () => (
        <LocaleProvider locale="en-US">
          <Format.Number value={9876.5} decimals={1} class="provided" />
          <Format.Number value={9876.5} decimals={1} locale="de" class="overridden" />
        </LocaleProvider>
      ),
      dom.root,
    );

    expect(dom.root.querySelector(".provided")?.textContent).toBe("9,876.5");
    expect(dom.root.querySelector(".overridden")?.textContent).toBe("9.876,5");

    dispose();
    dom.cleanup();
  });

  test("NumberInput edits localized decimals without changing the numeric contract", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "de");
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const changes: Array<number | null> = [];
    const commits: Array<number | null> = [];
    const [value, setValue] = createSignal<number | null>(1234.5);

    const dispose = render(
      () =>
        createComponent(NumberInput, {
          label: "Preis",
          decimalPlaces: 2,
          step: 0.01,
          value,
          onValueChange: (next) => {
            changes.push(next);
            setValue(next);
          },
          onValueCommit: (next) => commits.push(next),
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    // Raw editable text: locale decimal separator, never grouping.
    expect(input.value).toBe("1234,50");

    input.focus();
    input.value = "3.14";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("3,14");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(changes.at(-1)).toBe(3.14);
    expect(input.getAttribute("aria-valuenow")).toBe("3.14");

    input.blur();
    expect(commits.at(-1)).toBe(3.14);
    expect(input.value).toBe("3,14");

    // Partial and negative input states survive while typing.
    input.focus();
    input.value = "-2,";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("-2,");
    input.value = "-2,5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(changes.at(-1)).toBe(-2.5);
    input.blur();
    expect(commits.at(-1)).toBe(-2.5);
    expect(input.value).toBe("-2,50");

    dispose();
    dom.cleanup();
  });

  test("NumberInput pads on blur without moving the caret or emitting another change", async () => {
    const dom = createDomTestHarness();
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const changes: Array<number | null> = [];
    const commits: Array<number | null> = [];
    const [value, setValue] = createSignal<number | null>(321.4);
    const [locale, setLocale] = createSignal("de");
    const [precision, setPrecision] = createSignal(2);
    const dispose = render(
      () =>
        createComponent(NumberInput, {
          value,
          step: 0.01,
          get decimalPlaces() {
            return precision();
          },
          get locale() {
            return locale();
          },
          onValueChange: (next) => {
            changes.push(next);
            setValue(next);
          },
          onValueCommit: (next) => commits.push(next),
        }),
      dom.root,
    );
    const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    expect(input.value).toBe("321,40");
    expect(changes).toEqual([]);
    input.focus();
    input.value = "321,4";
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("321,4");
    expect(input.selectionStart).toBe(3);
    input.blur();
    expect(input.value).toBe("321,40");
    expect(changes).toEqual([321.4]);
    expect(commits).toEqual([321.4]);
    input.focus();
    input.blur();
    expect(changes).toEqual([321.4]);
    setLocale("en");
    expect(input.value).toBe("321.40");
    setPrecision(3);
    expect(input.value).toBe("321.400");
    setValue(1.23456);
    expect(input.value).toBe("1.235");
    expect(changes).toEqual([321.4]);
    setValue(null);
    expect(input.value).toBe("");
    dispose();
    dom.cleanup();
  });

  test("NumberInput round-trips padded negatives, zero, integer precision and large values", async () => {
    const dom = createDomTestHarness();
    const { NumberInput } = await import("../src/inputs/NumberInput");
    for (const [initial, precision, text] of [
      [-321.4, 2, "-321,40"],
      [0, 2, "0,00"],
      [42, 0, "42"],
      [1234567890123.5, 2, "1234567890123,50"],
      [1e21, 2, "1000000000000000000000,00"],
      [1e21, 0, "1000000000000000000000"],
    ] as const) {
      const changes: Array<number | null> = [];
      const commits: Array<number | null> = [];
      const [value, setValue] = createSignal<number | null>(initial);
      const dispose = render(
        () =>
          createComponent(NumberInput, {
            value,
            locale: "de",
            decimalPlaces: precision,
            step: precision === 0 ? 1 : 0.01,
            onValueChange: (next) => {
              changes.push(next);
              setValue(next);
            },
            onValueCommit: (next) => commits.push(next),
          }),
        dom.root,
      );
      const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
      expect(input.value).toBe(text);
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      expect(value()).toBe(initial);
      expect(input.value).toBe(text);
      expect(changes).toEqual([initial]);
      expect(commits).toEqual([initial]);
      dispose();
    }
    dom.cleanup();
  });

  test("NumberInput accepts a locale prop override and custom stepper labels", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "de");
    const { NumberInput } = await import("../src/inputs/NumberInput");

    const dispose = render(
      () =>
        createComponent(NumberInput, {
          label: "Amount",
          decimalPlaces: 1,
          locale: "en-US",
          value: 2.5,
          increaseLabel: "Mehr",
          decreaseLabel: "Weniger",
        }),
      dom.root,
    );

    const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    expect(input.value).toBe("2.5");
    const steppers = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-number-input__step"));
    expect(steppers.map((button) => button.getAttribute("aria-label"))).toEqual(["Weniger", "Mehr"]);

    dispose();
    dom.cleanup();
  });

  test("NumberInput derives the accepted decimals from a fractional step", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "de");
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const type = (input: HTMLInputElement, text: string) => {
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    };

    for (const typed of ["0,15", "0.15"]) {
      const [value, setValue] = createSignal<number | null>(null);
      const dispose = render(() => createComponent(NumberInput, { label: "Preis", step: 0.01, value, onValueChange: setValue }), dom.root);
      const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
      expect(input.getAttribute("inputmode")).toBe("decimal");
      type(input, typed);
      expect(value()).toBe(0.15);
      expect(input.value).toBe("0,15");
      dispose();
    }

    // Six fraction digits: the step decides, no explicit `decimalPlaces` needed.
    const [price, setPrice] = createSignal<number | null>(null);
    const disposePrice = render(
      () => createComponent(NumberInput, { label: "Preis", step: 0.000001, value: price, onValueChange: setPrice }),
      dom.root,
    );
    type(dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!, "0,123456789");
    expect(price()).toBe(0.123456);
    disposePrice();

    // An explicit `decimalPlaces` stays authoritative over the step: the second fraction digit is dropped while typing.
    const [explicit, setExplicit] = createSignal<number | null>(null);
    const disposeExplicit = render(
      () => createComponent(NumberInput, { label: "Preis", step: 0.01, decimalPlaces: 1, value: explicit, onValueChange: setExplicit }),
      dom.root,
    );
    type(dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!, "0,15");
    expect(explicit()).toBe(0.1);
    disposeExplicit();

    // An integer step still rejects the separator.
    const [count, setCount] = createSignal<number | null>(null);
    const disposeCount = render(
      () => createComponent(NumberInput, { label: "Anzahl", step: 1, value: count, onValueChange: setCount }),
      dom.root,
    );
    const integer = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    expect(integer.getAttribute("inputmode")).toBe("numeric");
    type(integer, "0,15");
    expect(integer.value).toBe("15");
    expect(count()).toBe(15);
    disposeCount();

    dom.cleanup();
  });

  test("renders time elements with canonical datetime in the browser", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "de");
    const { Format } = await import("../src/intl");

    const dispose = render(() => <Format.RelativeTime value="2025-03-05T12:00:00Z" base="2025-03-05T14:00:00Z" />, dom.root);

    const time = dom.root.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2025-03-05T12:00:00.000Z");
    expect(time?.textContent).toBe("vor 2 Stunden");

    dispose();
    dom.cleanup();
  });
});
