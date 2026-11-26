import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) {
  test.skip("a v2 choice needs browser export conditions", () => {});
} else {
  test("a v2 choice shows the page's value when the page keeps it or decides later", async () => {
    const dom = createDomTestHarness();
    const { Choice } = await import("../src/v2");
    const [value, setValue] = createSignal("a");
    let decide: ((accept: boolean) => void) | undefined;
    const dispose = render(
      () => (
        <Choice
          label="Kind"
          options={["a", "b"]}
          value={value()}
          onChange={async (next) => {
            // The page asks first, the way a form asks before it replaces typed input.
            if (await new Promise<boolean>((resolve) => (decide = resolve))) setValue(next);
          }}
        />
      ),
      dom.root,
    );
    const point = (name: string) => dom.root.querySelector<HTMLInputElement>(`input[value="${name}"]`)!;

    point("b").click();
    expect(point("a").checked).toBe(true);
    expect(point("b").checked).toBe(false);
    decide?.(false);
    await Promise.resolve();
    expect(point("a").checked).toBe(true);

    point("b").click();
    decide?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(point("b").checked).toBe(true);
    expect(point("a").checked).toBe(false);
    dispose();
    dom.cleanup();
  });
}
