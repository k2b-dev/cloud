import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { ChatDecisionProps } from "../src/chat/types";
import { createDomTestHarness } from "./dom";

/** A promise the test settles itself. */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

const mount = async (props: Partial<ChatDecisionProps>) => {
  const dom = createDomTestHarness();
  const { ChatDecision } = await import("../src/chat/ChatDecision");
  const errors: unknown[] = [];
  const dispose = render(
    () =>
      createComponent(ChatDecision, {
        state: "open",
        kind: { label: "Approval", icon: "ti ti-shield-check" },
        source: { name: "Mail", icon: "ti ti-mail" },
        sentence: "Send the mail?",
        reason: { text: "You asked to review it." },
        onAnswerError: (error) => errors.push(error),
        ...props,
      }),
    dom.root,
  );
  const button = (name: string) => {
    const found = Array.from(dom.root.querySelectorAll("button")).find((b) => b.textContent === name);
    if (!found) throw new Error(`No button ${name}`);
    return found;
  };
  const click = (name: string) => button(name).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  return {
    button,
    click,
    errors,
    done: () => {
      dispose();
      dom.cleanup();
    },
  };
};

/** An answer that counts its calls. */
const counted = (label: string, run: () => void | Promise<void>) => {
  const answer = {
    label,
    calls: 0,
    onSelect: () => {
      answer.calls++;
      return run();
    },
  };
  return answer;
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("a second press while the first answer still runs sends nothing; every answer waits for it", async () => {
    const first = deferred();
    const confirm = counted("Send", () => first.promise);
    const decline = counted("Keep draft", () => undefined);
    const more = counted("Withdraw", () => undefined);
    const back = counted("Change", () => undefined);
    const view = await mount({ confirm, decline, more: [more], back });
    try {
      view.click("Send");
      await flush();
      view.click("Send");
      view.click("Keep draft");
      view.click("Withdraw");
      view.click("Change");
      await flush();
      expect([confirm.calls, decline.calls, more.calls, back.calls]).toEqual([1, 0, 0, 0]);
      // Every answer says it takes no press, the pressed one that it works; none leaves the focus order.
      for (const name of ["Send", "Keep draft", "Withdraw", "Change"]) {
        expect(view.button(name).getAttribute("aria-disabled")).toBe("true");
        expect(view.button(name).hasAttribute("disabled")).toBe(false);
      }
      expect(view.button("Send").getAttribute("aria-busy")).toBe("true");
      expect(view.button("Send").hasAttribute("data-busy")).toBe(true);
      expect(view.button("Keep draft").hasAttribute("aria-busy")).toBe(false);

      first.resolve();
      await flush();
      // The host kept the question open: the answers work again.
      expect(view.button("Send").hasAttribute("aria-disabled")).toBe(false);
      expect(view.button("Send").hasAttribute("aria-busy")).toBe(false);
      expect(view.button("Send").hasAttribute("data-busy")).toBe(false);
      view.click("Keep draft");
      expect(decline.calls).toBe(1);
    } finally {
      view.done();
    }
  });

  test("a rejected answer gives the answers back once, without sending again", async () => {
    const first = deferred();
    const decline = counted("Keep draft", () => first.promise);
    const confirm = counted("Send", () => undefined);
    const view = await mount({ confirm, decline });
    try {
      view.click("Keep draft");
      view.click("Keep draft");
      expect(view.button("Keep draft").getAttribute("aria-busy")).toBe("true");
      const failure = new Error("offline");
      first.reject(failure);
      await flush();
      expect(view.errors).toEqual([failure]);
      expect(decline.calls).toBe(1);
      expect(view.button("Keep draft").hasAttribute("aria-disabled")).toBe(false);
      view.click("Send");
      expect(confirm.calls).toBe(1);
    } finally {
      view.done();
    }
  });

  test("a further answer that still runs holds every answer, and only itself, until it settles", async () => {
    const first = deferred();
    const more = counted("Withdraw", () => first.promise);
    const confirm = counted("Send", () => undefined);
    const view = await mount({ confirm, more: [{ label: "Pause", onSelect: () => undefined }, more] });
    try {
      view.click("Withdraw");
      view.click("Withdraw");
      view.click("Send");
      await flush();
      expect([more.calls, confirm.calls]).toEqual([1, 0]);
      expect(view.button("Withdraw").getAttribute("aria-busy")).toBe("true");
      expect(view.button("Pause").hasAttribute("aria-busy")).toBe(false);
      expect(view.button("Pause").getAttribute("aria-disabled")).toBe("true");
      first.resolve();
      await flush();
      view.click("Withdraw");
      expect(more.calls).toBe(2);
    } finally {
      view.done();
    }
  });

  test("a synchronous answer keeps working as before: a host that keeps the question open takes the next press", async () => {
    const confirm = counted("Send", () => undefined);
    const view = await mount({ confirm });
    try {
      view.click("Send");
      expect(view.button("Send").hasAttribute("aria-disabled")).toBe(false);
      await flush();
      view.click("Send");
      expect(confirm.calls).toBe(2);
    } finally {
      view.done();
    }
  });
}
