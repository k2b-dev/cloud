import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// #3897: a grouped amount must never lose digits silently. The locale decides
// which mark groups and which separates decimals; text that fits neither stays
// in the field with an error instead of committing a wrong number.
describe("NumberInput grouped amounts", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions process", () => {});
    return;
  }

  const mount = async (options: { locale: string; step?: number; initial?: number | null }) => {
    const dom = createDomTestHarness();
    // Messages follow the inherited locale; the `locale` prop sets the separators.
    document.documentElement.setAttribute("lang", options.locale);
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const changes: Array<number | null> = [];
    const commits: Array<number | null> = [];
    const [value, setValue] = createSignal<number | null>(options.initial ?? null);
    const dispose = render(
      () =>
        createComponent(NumberInput, {
          label: "Betrag",
          locale: options.locale,
          step: options.step ?? 0.01,
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
    // One input event for the whole text, as a paste or an autofill delivers it.
    const write = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const error = () => dom.root.querySelector(".k2b-field__error")?.textContent ?? null;
    const close = () => {
      dispose();
      dom.cleanup();
    };
    return { input, write, error, value, setValue, changes, commits, close };
  };

  const cases: Array<[locale: string, text: string, expected: number, step?: number]> = [
    ["de", "2.977,17", 2977.17],
    ["en", "2,977.17", 2977.17],
    ["de", "1.234.567,89", 1234567.89],
    ["en", "1,234,567.89", 1234567.89],
    // One mark with three digits after it groups in the locale that groups with it.
    ["de", "2.977", 2977],
    ["en", "2,977", 2977],
    // The other mark that cannot group still reads as the decimal separator.
    ["de", "3.14", 3.14],
    ["en", "3,14", 3.14],
    ["de", "0.125", 0.13],
    ["de", "1.234", 1234, 1],
    ["en", "-1,234.5", -1234.5],
  ];

  for (const [locale, text, expected, step] of cases) {
    test(`${locale}: "${text}" commits ${expected}`, async () => {
      const field = await mount({ locale, step });
      field.input.focus();
      field.write(text);
      expect(field.input.value).toBe(text);
      field.input.blur();
      expect(field.commits).toEqual([expected]);
      expect(field.value()).toBe(expected);
      expect(field.error()).toBeNull();
      field.close();
    });
  }

  test("typing a German amount key by key keeps the grouping until it is complete", async () => {
    const field = await mount({ locale: "de" });
    field.input.focus();
    let text = "";
    for (const key of "2.977,17") {
      text += key;
      field.write(text);
      expect(field.input.value).toBe(text);
    }
    expect(field.changes.at(-1)).toBe(2977.17);
    field.input.blur();
    expect(field.commits).toEqual([2977.17]);
    expect(field.input.value).toBe("2977,17");
    field.close();
  });

  test("pasting a German amount with a currency sign replaces the value", async () => {
    const field = await mount({ locale: "de", initial: 12.5 });
    expect(field.input.value).toBe("12,50");
    field.input.focus();
    field.write("€ 2.977,17");
    expect(field.input.value).toBe("2.977,17");
    expect(field.changes.at(-1)).toBe(2977.17);
    field.input.blur();
    expect(field.commits).toEqual([2977.17]);
    expect(field.input.value).toBe("2977,17");
    field.close();
  });

  test("text that fits neither reading keeps its text, shows an error and commits nothing", async () => {
    const field = await mount({ locale: "de", initial: 12.5 });
    field.input.focus();
    let text = "";
    for (const key of "2,977.17") {
      text += key;
      field.write(text);
    }
    // The live value never holds a number read from rejected text.
    expect(field.value()).toBe(12.5);
    field.input.blur();
    expect(field.input.value).toBe("2,977.17");
    expect(field.commits).toEqual([]);
    expect(field.value()).toBe(12.5);
    expect(field.error()).toBe("Keine Zahl. Beispiel: 1.234,56");
    expect(field.input.getAttribute("aria-invalid")).toBe("true");
    expect(field.input.validationMessage).toBe("Keine Zahl. Beispiel: 1.234,56");

    // Correcting the text clears the error and commits.
    field.input.focus();
    field.write("2.977,17");
    expect(field.error()).toBeNull();
    field.input.blur();
    expect(field.commits).toEqual([2977.17]);
    expect(field.input.validationMessage).toBe("");
    field.close();
  });

  test("Enter commits before a form submits, and refused text keeps the form from submitting", async () => {
    const field = await mount({ locale: "de", initial: 7 });
    const enter = () => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      field.input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    field.input.focus();
    field.write("2.977,1749");
    expect(enter()).toBe(false);
    expect(field.commits).toEqual([2977.17]);
    expect(field.value()).toBe(2977.17);

    field.write("2,977.17");
    // Form validation already refuses the text while it is typed.
    expect(field.input.validationMessage).toBe("Keine Zahl. Beispiel: 1.234,56");
    expect(enter()).toBe(true);
    expect(field.error()).toBe("Keine Zahl. Beispiel: 1.234,56");
    expect(field.value()).toBe(2977.17);
    expect(field.commits).toEqual([2977.17]);
    field.close();
  });

  test("a stray minus, separators alone, overflow and unfocused input are refused, not guessed", async () => {
    const field = await mount({ locale: "de", initial: 7 });
    for (const text of ["2.977,17-", "1-2", ",", "-", "9".repeat(400)]) {
      field.input.focus();
      field.write(text);
      field.input.blur();
      expect(field.input.value).toBe(text);
      expect(field.error()).toBe("Keine Zahl. Beispiel: 1.234,56");
    }
    expect(field.commits).toEqual([]);
    expect(field.value()).toBe(7);

    // Autofill writes without focus, so no blur follows: the refusal shows at once and the value stays.
    field.setValue(8);
    field.write("2,977.17");
    expect(field.input.value).toBe("2,977.17");
    expect(field.error()).toBe("Keine Zahl. Beispiel: 1.234,56");
    expect(field.value()).toBe(8);
    field.close();
  });

  test("a plain field with formatValue keeps refused text visible at rest", async () => {
    const dom = createDomTestHarness();
    document.documentElement.setAttribute("lang", "en");
    const { NumberInput } = await import("../src/inputs/NumberInput");
    const [value, setValue] = createSignal<number | null>(90);
    const dispose = render(
      () =>
        createComponent(NumberInput, {
          "aria-label": "Estimate",
          appearance: "plain",
          formatValue: (minutes: number) => `${minutes} min`,
          value,
          onValueCommit: setValue,
        }),
      dom.root,
    );
    const input = dom.root.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    const sizer = () => dom.root.querySelector<HTMLElement>(".k2b-number-input__sizer")!;
    input.focus();
    input.value = "1,2.3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    expect(sizer().dataset.value).toBe("1,2.3");
    expect(input.hasAttribute("aria-valuetext")).toBe(false);
    expect(value()).toBe(90);
    dispose();
    dom.cleanup();
  });

  test("misplaced grouping in English is refused, and a new value from outside replaces it", async () => {
    const field = await mount({ locale: "en" });
    for (const text of ["2.977,17", "12,34,567", "1,2.5", "1.2.3"]) {
      field.input.focus();
      field.write(text);
      field.input.blur();
      expect(field.input.value).toBe(text);
      expect(field.error()).toBe("Not a number. Example: 1,234.56");
    }
    expect(field.commits).toEqual([]);
    expect(field.value()).toBeNull();
    field.setValue(42);
    expect(field.input.value).toBe("42.00");
    expect(field.error()).toBeNull();
    field.close();
  });
});
