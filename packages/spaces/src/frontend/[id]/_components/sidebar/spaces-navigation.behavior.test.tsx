import { afterAll, afterEach, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) {
  test.skip("pin sharing uses browser conditions", () => {});
} else {
  const dom = createDomTestHarness();
  afterAll(() => dom.cleanup());
  const { createPinnedSpaces } = await import("./spaces-navigation");
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    dom.root.replaceChildren();
  });
  const mount = (initial: string[]) => {
    const target = dom.document.createElement("div");
    dom.root.append(target);
    let update = (_next: string[]) => {};
    disposers.push(
      render(() => {
        const [pinned, setPinned] = createPinnedSpaces(initial);
        update = setPinned;
        return <span>{JSON.stringify(pinned())}</span>;
      }, target),
    );
    return { target, update };
  };

  test("a late island receives pins changed locally by an earlier island", () => {
    const a = mount(["Space1"]);
    a.update(["Space2", "Space1"]);
    const b = mount(["Space1"]);
    expect(b.target.textContent).toBe('["Space2","Space1"]');
    expect(a.target.textContent).toBe('["Space2","Space1"]');
  });

  test("unchanged islands preserve their own server pins", () => {
    const a = mount(["Space2"]);
    const b = mount(["Space1"]);
    expect(b.target.textContent).toBe('["Space1"]');
    expect(a.target.textContent).toBe('["Space2"]');
  });
}
