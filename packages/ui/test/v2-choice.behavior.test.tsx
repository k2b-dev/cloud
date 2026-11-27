import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// A v2 Choice the page holds (`value` + `onChange`) shows the page's value, not the person's press: when the page
// refuses a choice, or decides later (after a confirm), every option shows the page's value again, the native radio
// too, so a form sends what the page holds and the next press on the refused option fires again (W3, Spaces).
describe("v2 Choice held by the page", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions process", () => {});
    return;
  }

  const mount = async () => {
    const dom = createDomTestHarness();
    const { Choice } = await import("../src/v2/controls");
    const [value, setValue] = createSignal("week");
    const asked: string[] = [];
    const dispose = render(
      () =>
        createComponent(Choice, {
          name: "view",
          label: "Ansicht",
          options: [
            { value: "week", label: "Woche" },
            { value: "month", label: "Monat" },
          ],
          get value() {
            return value();
          },
          // the page asks first and keeps its value for now
          onChange: (next: string) => asked.push(next),
        }),
      dom.root,
    );
    const radio = (code: string) => dom.root.querySelector<HTMLInputElement>(`input[value="${code}"]`)!;
    const press = (code: string) => radio(code).click();
    return {
      radio,
      press,
      asked,
      setValue,
      close: () => {
        dispose();
        dom.cleanup();
      },
    };
  };

  test("a refused choice goes back to the page's value, the native radio too", async () => {
    const view = await mount();
    view.press("month");
    expect(view.asked).toEqual(["month"]);
    expect(view.radio("week").checked).toBe(true);
    expect(view.radio("month").checked).toBe(false);
    // the refused option can be pressed again and asks again
    view.press("month");
    expect(view.asked).toEqual(["month", "month"]);
    view.close();
  });

  test("a choice the page takes later shows once the page sets it", async () => {
    const view = await mount();
    view.press("month");
    expect(view.radio("week").checked).toBe(true);
    view.setValue("month");
    expect(view.radio("month").checked).toBe(true);
    expect(view.radio("week").checked).toBe(false);
    view.close();
  });
});
