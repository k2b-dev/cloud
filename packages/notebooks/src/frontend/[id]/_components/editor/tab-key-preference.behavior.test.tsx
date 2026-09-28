import { describe, expect, test } from "bun:test";
import { createCodeMirror } from "solid-codemirror";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { TAB_KEY_PREFERENCE_EVENT } from "../detail/events";
import { setTabMovesFocus } from "../settings/NotebookSettingsStore";
import { createTabKeyPreference } from "./tab-key-preference";

/** Mounts an editor the way the note editor wires the preference: one compartment for the Tab keys. */
const mount = ({ readOnly = false, savedTabMovesFocus = false } = {}) => {
  const dom = createDomTestHarness();
  if (savedTabMovesFocus) setTabMovesFocus(true);
  let tabKeys!: ReturnType<typeof createTabKeyPreference>;
  const dispose = render(() => {
    const { ref, createExtension } = createCodeMirror({ value: "- Passport\n- Charger" });
    tabKeys = createTabKeyPreference(() => readOnly);
    createExtension(tabKeys.extension);
    return <div ref={ref} />;
  }, dom.root);
  const content = () => dom.root.querySelector<HTMLElement>(".cm-content")!;
  /** `true` means the editor kept Tab; `false` lets the browser move focus. */
  const pressTab = () => {
    const event = new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true, cancelable: true });
    content().dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {
    tabKeys,
    content,
    pressTab,
    [Symbol.dispose]: () => {
      dispose();
      dom.cleanup();
    },
  };
};

const changePreference = (tabMovesFocus: boolean) => {
  setTabMovesFocus(tabMovesFocus);
  window.dispatchEvent(new Event(TAB_KEY_PREFERENCE_EVENT));
};

describe("note editor Tab key preference", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("an open editor follows the preference without a reload", () => {
    using editor = mount();
    expect(editor.tabKeys.indents()).toBe(true);
    expect(editor.content().getAttribute("aria-describedby")).toBe(editor.tabKeys.hintId);
    expect(editor.pressTab()).toBe(true);

    changePreference(true);
    expect(editor.tabKeys.indents()).toBe(false);
    expect(editor.content().hasAttribute("aria-describedby")).toBe(false);
    expect(editor.pressTab()).toBe(false);

    changePreference(false);
    expect(editor.tabKeys.indents()).toBe(true);
    expect(editor.content().getAttribute("aria-describedby")).toBe(editor.tabKeys.hintId);
    expect(editor.pressTab()).toBe(true);
  });

  test("a saved preference applies when the editor opens", () => {
    using editor = mount({ savedTabMovesFocus: true });
    expect(editor.tabKeys.indents()).toBe(false);
    expect(editor.content().hasAttribute("aria-describedby")).toBe(false);
    expect(editor.pressTab()).toBe(false);
  });

  test("a read-only note never takes Tab", () => {
    using editor = mount({ readOnly: true });
    changePreference(false);
    expect(editor.tabKeys.indents()).toBe(false);
    expect(editor.content().hasAttribute("aria-describedby")).toBe(false);
    expect(editor.pressTab()).toBe(false);
  });
});
