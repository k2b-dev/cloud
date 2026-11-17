import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Load once outside any test, so the cold Solid transform of the library source does not count against the 5 s test
// timeout. The library needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("../src");
  } finally {
    dom.cleanup();
  }
};
const { TimeInput, LocaleProvider } = await load();

const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (input: HTMLInputElement, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
};
const blur = (input: HTMLInputElement) => input.dispatchEvent(new FocusEvent("blur"));

const mount = (props: Record<string, unknown> = {}, locale = "en") => {
  const dom = createDomTestHarness();
  const [value, setValue] = createSignal<string | null>((props.initial as string | null | undefined) ?? "09:30");
  const changes: (string | null)[] = [];
  const commits: (string | null)[] = [];
  const dispose = render(
    () => (
      <LocaleProvider locale={locale}>
        <form>
          <TimeInput
            label="Start"
            value={value}
            onValueChange={(next) => {
              changes.push(next);
              setValue(next);
            }}
            onValueCommit={(next) => commits.push(next)}
            {...props}
          />
        </form>
      </LocaleProvider>
    ),
    dom.root,
  );
  const input = dom.root.querySelector("input")!;
  const error = () => dom.root.querySelector(".k2b-field__error")?.textContent ?? null;
  return {
    input,
    value,
    setValue,
    changes,
    commits,
    error,
    root: dom.root,
    done: () => {
      dispose();
      dom.cleanup();
    },
  };
};

test("a text field with the numeric keypad shows the value as HH:mm", () => {
  const field = mount();
  expect(field.input.type).toBe("text");
  expect(field.input.inputMode).toBe("numeric");
  expect(field.input.value).toBe("09:30");
  expect(field.input.placeholder).toBe("hh:mm");
  expect(field.input.getAttribute("aria-labelledby")).toBe(field.root.querySelector("label")!.id);
  field.done();
});

test("leaving the field commits short input as a full time, once", () => {
  const field = mount();
  type(field.input, "9:");
  type(field.input, "9:4");
  type(field.input, "9:45");
  expect(field.changes).toEqual([]);
  blur(field.input);
  expect(field.input.value).toBe("09:45");
  expect(field.value()).toBe("09:45");
  expect(field.changes).toEqual(["09:45"]);
  expect(field.commits).toEqual(["09:45"]);
  type(field.input, "1715");
  const enter = key(field.input, "Enter");
  // A committed time lets Enter submit the surrounding form.
  expect(enter.defaultPrevented).toBeFalse();
  expect(field.value()).toBe("17:15");
  field.done();
});

test("a refused text stays with its reason, keeps the value and blocks Enter and the form", () => {
  const field = mount({}, "de");
  type(field.input, "25");
  blur(field.input);
  expect(field.input.value).toBe("25");
  expect(field.error()).toBe("Keine Uhrzeit. Beispiel: 09:30");
  expect(field.input.getAttribute("aria-invalid")).toBe("true");
  expect(field.input.validationMessage).toBe("Keine Uhrzeit. Beispiel: 09:30");
  expect(field.value()).toBe("09:30");
  expect(key(field.input, "Enter").defaultPrevented).toBeTrue();
  // Typing an allowed time clears the red at once; Escape returns to the saved value.
  type(field.input, "8");
  expect(field.error()).toBeNull();
  const escape = key(field.input, "Escape");
  expect(escape.defaultPrevented).toBeTrue();
  expect(field.input.value).toBe("09:30");
  expect(field.input.validationMessage).toBe("");
  expect(field.changes).toEqual([]);
  field.done();
});

test("step snaps to its grid and min and max refuse with the nearest allowed time", () => {
  const field = mount({ step: 15, min: "08:00", max: "18:00" });
  type(field.input, "907");
  blur(field.input);
  expect(field.value()).toBe("09:00");
  type(field.input, "7");
  blur(field.input);
  expect(field.error()).toBe("08:00 at the earliest.");
  type(field.input, "19");
  blur(field.input);
  expect(field.error()).toBe("18:00 at the latest.");
  expect(field.value()).toBe("09:00");
  field.done();
});

test("24:00 is a time only where max allows it", () => {
  const end = mount({ max: "24:00" });
  type(end.input, "24");
  blur(end.input);
  expect(end.value()).toBe("24:00");
  end.done();
  const start = mount();
  type(start.input, "24");
  blur(start.input);
  expect(start.error()).toBe("23:59 at the latest.");
  start.done();
});

test("an empty field commits null, or asks for a time when required", () => {
  const optional = mount();
  type(optional.input, "");
  blur(optional.input);
  expect(optional.value()).toBeNull();
  expect(optional.input.value).toBe("");
  optional.done();
  const required = mount({ required: true });
  type(required.input, "");
  blur(required.input);
  expect(required.error()).toBe("Enter a time.");
  expect(required.value()).toBe("09:30");
  required.done();
});

test("a value set from outside replaces the text and an app error shows in the field's slot", () => {
  const field = mount({ error: "Ends before it starts." });
  expect(field.error()).toBe("Ends before it starts.");
  field.setValue("11:00");
  expect(field.input.value).toBe("11:00");
  field.done();
});

test("a disabled field cannot be edited", () => {
  const field = mount({ disabled: true });
  expect(field.input.disabled).toBeTrue();
  expect(field.root.querySelector(".k2b-field")!.getAttribute("data-disabled")).toBe("true");
  expect(field.root.querySelector(".k2b-time-input")!.getAttribute("data-disabled")).toBe("true");
  field.done();
});
