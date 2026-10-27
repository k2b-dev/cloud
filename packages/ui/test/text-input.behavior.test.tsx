import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Load once outside any test, so the cold Solid transform of the library source does not count against the 5 s test
// timeout. The library needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("../src")).TextInput;
  } finally {
    dom.cleanup();
  }
};
const TextInput = await load();

test("Enter submits a single-line TextInput without submitting a surrounding form twice", async () => {
  const dom = createDomTestHarness();
  const [value, setValue] = createSignal("");
  let submitted = 0;
  const dispose = render(() => <TextInput label="Search" value={value} onValueChange={setValue} onSubmit={() => submitted++} />, dom.root);
  const input = dom.root.querySelector("input")!;
  input.value = "report";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(value()).toBe("report");
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  expect(submitted).toBe(1);
  expect(enter.defaultPrevented).toBeTrue();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  expect(submitted).toBe(1);
  dispose();
  dom.cleanup();
});

test("the caller's key handler runs, and a key it handles does not submit", async () => {
  const dom = createDomTestHarness();
  const keys: string[] = [];
  let submitted = 0;
  const dispose = render(
    () => (
      <TextInput
        label="Search"
        type="search"
        value=""
        onSubmit={() => submitted++}
        onKeyDown={(event) => {
          keys.push(event.key);
          if (event.key === "Enter" && event.altKey) event.preventDefault();
        }}
      />
    ),
    dom.root,
  );
  const input = dom.root.querySelector("input")!;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(keys).toEqual(["Escape", "Enter", "Enter"]);
  expect(submitted).toBe(1);
  dispose();
  dom.cleanup();
});

test("TextInput keeps phone keyboards from capitalizing or correcting user names, addresses, and passwords", async () => {
  const dom = createDomTestHarness();
  const dispose = render(
    () => (
      <>
        <TextInput label="User" value="" autocomplete="username" />
        <TextInput label="Email" value="" type="email" />
        <TextInput label="Password" value="" password />
        <TextInput label="Override" value="" autocomplete="email" autocapitalize="words" />
        <TextInput label="Title" value="" />
      </>
    ),
    dom.root,
  );
  const [user, email, password, override, title] = [...dom.root.querySelectorAll("input")];
  for (const input of [user, email, password]) {
    expect(input!.getAttribute("autocapitalize")).toBe("none");
    expect(input!.getAttribute("autocorrect")).toBe("off");
    expect(input!.getAttribute("spellcheck")).toBe("false");
  }
  expect(override!.getAttribute("autocapitalize")).toBe("words");
  expect(title!.hasAttribute("autocapitalize")).toBeFalse();
  expect(title!.hasAttribute("spellcheck")).toBeFalse();
  dispose();
  dom.cleanup();
});

test("compact values retain names, refs, submission and associated errors without an icon well", () => {
  const dom = createDomTestHarness();
  let inputRef: HTMLInputElement | undefined;
  let submitted = 0;
  const dispose = render(
    () => (
      <>
        <TextInput
          variant="compact"
          prefix={<span>:region</span>}
          aria-label="Region"
          value="Europe"
          error="Enter a region"
          readOnly
          ref={(element) => {
            inputRef = element;
          }}
          onSubmit={() => submitted++}
        />
        <TextInput label="Default" value="Europe" error="Enter a region" />
      </>
    ),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLInputElement>('input[aria-label="Region"]')!;
    expect(input).toBe(inputRef!);
    expect(input.readOnly).toBeTrue();
    expect(input.size).toBe(9);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const error = dom.document.getElementById(input.getAttribute("aria-describedby")!);
    expect(error?.textContent).toBe("Enter a region");
    expect(error?.classList.contains("k2b-field__error--sr-only")).toBeFalse();
    const shell = input.parentElement!;
    expect(shell.textContent).toContain(":region");
    expect(shell.querySelector(".k2b-input-shell__icon")).toBeNull();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(submitted).toBe(1);
    expect(enter.defaultPrevented).toBeTrue();
    const defaultField = dom.root.querySelector('input:not([aria-label="Region"])')!.closest(".k2b-field")!;
    expect(defaultField.querySelector(".k2b-input-shell__icon")).not.toBeNull();
    expect(defaultField.querySelector(".k2b-field__error--sr-only")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.each([false, true])("external errors update without replacing the native control (multiline=%s)", (multiline) => {
  const dom = createDomTestHarness();
  const [error, setError] = createSignal<string>();
  const [target, setTarget] = createSignal<string | undefined>("123:problem");
  let ref: HTMLElement | undefined;
  let edits = 0;
  const dispose = render(
    () => (
      <>
        <span id="context">Existing help</span>
        <TextInput
          id="region"
          label="Region"
          description="Choose a region"
          aria-describedby="context"
          value="Europe"
          multiline={multiline}
          error={error}
          externalErrorId={target()}
          ref={(element) => {
            ref = element;
          }}
          onValueChange={() => edits++}
        />
        <p id={target()}>{error()}</p>
      </>
    ),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
    const shell = input.parentElement!;
    input.focus();
    input.setSelectionRange(1, 4);
    const preserved = () => {
      expect(dom.root.querySelector("input,textarea")).toBe(input);
      expect(ref).toBe(input);
      expect(dom.document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
      expect(input.value).toBe("Europe");
      expect(input.hasAttribute("externalErrorId")).toBeFalse();
    };
    expect(input.getAttribute("aria-describedby")).toBe("context region-description");
    expect(input.hasAttribute("aria-invalid")).toBeFalse();
    setError("Enter a region");
    expect(input.getAttribute("aria-describedby")).toBe("context region-description 123:problem");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(shell.dataset.invalid).toBe("true");
    expect(dom.root.querySelector(".k2b-field__error")).toBeNull();
    preserved();
    setTarget("another:error");
    setError("Use a known region");
    expect(input.getAttribute("aria-describedby")).toBe("context region-description another:error");
    expect(dom.document.getElementById("another:error")?.textContent).toBe("Use a known region");
    preserved();
    setTarget(undefined);
    expect(input.getAttribute("aria-describedby")).toBe("context region-description region-error");
    expect(dom.root.querySelector(".k2b-field__error")?.textContent).toBe("Use a known region");
    preserved();
    for (const invalid of ["", "two ids", "tab\tid", "line\nid", "return\rid", "form\fid"]) {
      setTarget(invalid);
      expect(input.getAttribute("aria-describedby")).toBe("context region-description region-error");
      expect(dom.root.querySelector(".k2b-field__error")?.textContent).toBe("Use a known region");
      preserved();
    }
    setTarget("123:problem");
    setError(undefined);
    expect(input.getAttribute("aria-describedby")).toBe("context region-description");
    expect(input.hasAttribute("aria-invalid")).toBeFalse();
    expect(shell.hasAttribute("data-invalid")).toBeFalse();
    expect(dom.root.querySelector(".k2b-field__error")).toBeNull();
    preserved();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(edits).toBe(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});
