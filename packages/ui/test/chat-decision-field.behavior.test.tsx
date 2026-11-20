import { afterAll, afterEach, expect, test } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { ChatDecisionAnswer, ChatDecisionFieldProps, ChatDecisionState } from "../src/index";
import { createDomTestHarness } from "./dom";

// A question that asks for one value, in the browser. The value is fictional and must stay inside the input.
const value = "pk_live_FICTIONAL_7f3Q";
const lines: ChatDecisionFieldProps["lines"] = {
  safe: { text: "Not in the chat history.", icon: "ti ti-shield-lock" },
  empty: { text: "Paste the key first.", icon: "ti ti-alert-circle", tone: "danger" },
  failed: { text: "Not saved. Try again.", icon: "ti ti-alert-circle", tone: "danger" },
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const dom = createDomTestHarness();
  const { Chat, ChatDecisionField } = await import("../src/index");
  delegateEvents(["click", "input", "keydown", "focusin"], dom.document);
  afterAll(() => dom.cleanup());
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    dom.root.replaceChildren();
  });

  const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms));

  /** A host that keeps the value, the line and the state, like the secret card does. */
  const mount = (
    options: { confirm?: ChatDecisionAnswer["onSelect"]; decline?: ChatDecisionAnswer["onSelect"]; disabled?: () => boolean } = {},
  ) => {
    const [state, setState] = createSignal<ChatDecisionState>("open");
    const [field, setField] = createSignal("");
    const [current, setCurrent] = createSignal("safe");
    const [invalid, setInvalid] = createSignal(false);
    let input: HTMLInputElement | undefined;
    const confirmed: string[] = [];
    const declined: number[] = [];
    dispose = render(
      (): JSX.Element => (
        <Chat.Decision
          state={state()}
          kind={{ label: "Secret", icon: "ti ti-key" }}
          sentence="Add Parcel_API?"
          entry={
            <ChatDecisionField
              label="Value for Parcel_API"
              value={field()}
              onValueChange={setField}
              revealLabel="Show value"
              lines={lines}
              current={current()}
              invalid={invalid()}
              disabled={options.disabled?.()}
              inputRef={(element) => {
                input = element;
              }}
              confirm={{
                label: "Save securely",
                onSelect:
                  options.confirm ??
                  (() => {
                    confirmed.push(field());
                  }),
              }}
              decline={{ label: "Decline", onSelect: options.decline ?? (() => void declined.push(1)) }}
            />
          }
          outcome={<Chat.Outcome current="done" lines={{ done: { tone: "done", text: "Secret saved" } }} />}
        />
      ),
      dom.root,
    );
    const section = () => dom.root.querySelector("section")!;
    const control = () => dom.root.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
    const live = () => dom.root.querySelector('.k2b-chat-decision__entry [role="status"]')!.textContent;
    return { state, setState, field, setCurrent, setInvalid, input: () => input, confirmed, declined, section, control, live };
  };

  const type = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  test("typing hands the value to the host and turns the question into the island for good", () => {
    const host = mount();
    expect(host.section().getAttribute("data-mode")).toBe("approve");
    expect(host.input()).toBe(host.control());
    type(host.control(), value);
    expect(host.field()).toBe(value);
    expect(host.section().getAttribute("data-mode")).toBe("edit");
    type(host.control(), "");
    expect(host.section().getAttribute("data-mode")).toBe("edit");
  });

  test("the focus alone turns it into the island", () => {
    const host = mount();
    host.control().focus();
    expect(host.section().getAttribute("data-mode")).toBe("edit");
    host.control().blur();
    expect(host.section().getAttribute("data-mode")).toBe("edit");
  });

  test("the eye shows the value with one fixed name and a pressed state", () => {
    const host = mount();
    const eye = dom.root.querySelector<HTMLButtonElement>(".k2b-input-shell__reveal")!;
    expect([host.control().type, eye.getAttribute("aria-label"), eye.getAttribute("aria-pressed")]).toEqual([
      "password",
      "Show value",
      "false",
    ]);
    eye.click();
    expect([host.control().type, eye.getAttribute("aria-label"), eye.getAttribute("aria-pressed")]).toEqual(["text", "Show value", "true"]);
    eye.click();
    expect(host.control().type).toBe("password");
  });

  test("the value lives only in the input's property, never in the page's markup", () => {
    const host = mount();
    type(host.control(), value);
    dom.root.querySelector<HTMLButtonElement>(".k2b-input-shell__reveal")!.click();
    expect(host.control().value).toBe(value);
    expect(dom.root.innerHTML).not.toContain(value);
  });

  test("Enter and the main answer hand over the value; decline answers too", async () => {
    const host = mount();
    type(host.control(), value);
    host.control().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(host.confirmed).toEqual([value]);
    await tick();
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__decline")!.click();
    expect(host.declined).toEqual([1]);
  });

  test("a locked field takes no answer, not even Enter", async () => {
    const [locked, setLocked] = createSignal(true);
    const host = mount({ disabled: locked });
    host.control().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__decline")!.click();
    expect([host.confirmed.length, host.declined.length]).toEqual([0, 0]);
    setLocked(false);
    await tick();
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    expect(host.confirmed.length).toBe(1);
  });

  test("an invalid value takes the focus back into the field and is announced once", async () => {
    const host = mount();
    const confirm = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!;
    confirm.focus();
    host.setCurrent("empty");
    host.setInvalid(true);
    expect(dom.document.activeElement).toBe(host.control());
    await tick(60);
    expect(host.live()).toBe("Paste the key first.");
    // The same words again are a change too.
    host.setInvalid(false);
    host.setCurrent("safe");
    host.setCurrent("empty");
    await tick(60);
    expect(host.live()).toBe("Paste the key first.");
  });

  test("an error elsewhere does not pull the focus away from where the person is now", () => {
    const outside = dom.document.createElement("button");
    dom.document.body.append(outside);
    try {
      const host = mount();
      outside.focus();
      host.setCurrent("empty");
      host.setInvalid(true);
      expect(dom.document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  test("a save that keeps the question open until it ends still moves the focus to the outcome", async () => {
    let finish = () => {};
    const [locked, setLocked] = createSignal(false);
    const host = mount({
      disabled: locked,
      confirm: () => {
        setLocked(true);
        return new Promise<void>((done) => {
          finish = () => {
            host.setState("decided");
            done();
          };
        });
      },
    });
    type(host.control(), value);
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    await tick();
    expect(host.state()).toBe("open");
    finish();
    await tick();
    expect(dom.document.activeElement).toBe(dom.root.querySelector(".k2b-chat-outcome"));
    expect(dom.root.querySelector("input")).toBeNull();
    expect(dom.root.innerHTML).not.toContain(value);
  });

  test("a failed save gives working answers back", async () => {
    let fail = () => {};
    const [locked, setLocked] = createSignal(false);
    let calls = 0;
    const host = mount({
      disabled: locked,
      confirm: () => {
        calls++;
        setLocked(true);
        return new Promise<void>((done) => {
          fail = () => {
            setLocked(false);
            host.setCurrent("failed");
            done();
          };
        });
      },
    });
    type(host.control(), value);
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    fail();
    await tick();
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    expect(calls).toBe(2);
    expect(host.field()).toBe(value);
  });

  test("a running save locks the field, the eye and both answers by itself and sends once", async () => {
    let fail = () => {};
    let calls = 0;
    const host = mount({
      confirm: () => {
        calls++;
        return new Promise<void>((done) => {
          fail = () => {
            host.setCurrent("failed");
            done();
          };
        });
      },
    });
    const confirm = () => dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!;
    const decline = () => dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__decline")!;
    const eye = () => dom.root.querySelector<HTMLButtonElement>(".k2b-input-shell__reveal")!;
    const enter = () => host.control().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    type(host.control(), value);
    host.control().focus();
    enter();
    enter();
    confirm().click();
    decline().click();
    expect([calls, host.declined.length]).toEqual([1, 0]);
    expect([host.control().disabled, eye().disabled]).toEqual([true, true]);
    // The answers stay focusable, as the question's own buttons do, and show which one runs.
    expect([confirm().disabled, confirm().getAttribute("aria-disabled"), confirm().getAttribute("aria-busy"), confirm().hasAttribute("data-busy")]).toEqual([
      false,
      "true",
      "true",
      true,
    ]);
    expect([decline().disabled, decline().getAttribute("aria-disabled"), decline().getAttribute("aria-busy")]).toEqual([false, "true", null]);
    // The lock took the focus from the field; the failed save gives it back with working answers.
    host.control().blur();
    fail();
    await tick();
    expect([host.control().disabled, eye().disabled, confirm().getAttribute("aria-disabled"), decline().getAttribute("aria-disabled")]).toEqual([
      false,
      false,
      null,
      null,
    ]);
    expect(dom.document.activeElement).toBe(host.control());
    expect(host.field()).toBe(value);
    enter();
    expect(calls).toBe(2);
  });

  test("a failed save does not pull the focus away from where the person is now", async () => {
    let fail = () => {};
    const host = mount({
      confirm: () =>
        new Promise<void>((done) => {
          fail = done;
        }),
    });
    const outside = dom.document.createElement("button");
    dom.document.body.append(outside);
    try {
      type(host.control(), value);
      dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
      outside.focus();
      fail();
      await tick();
      expect(dom.document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  test("a running decline holds the main answer too", async () => {
    let finish = () => {};
    const host = mount({
      decline: () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    });
    const decline = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__decline")!;
    decline.click();
    expect(decline.getAttribute("aria-busy")).toBe("true");
    host.control().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    expect(host.confirmed).toEqual([]);
    finish();
    await tick();
    dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
    expect(host.confirmed).toEqual([""]);
  });
}
