import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJSON } from "seroval";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { disposeIslands, mount, mountIslands } from "../../src/mount";
import { makeTempRoot } from "../temp-root";

const roots: string[] = [];
afterEach(() => {
  disposeIslands(document);
  document.body.replaceChildren();
  mock.restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const build = async (source: string, fallback?: string) => {
  const root = makeTempRoot(".ssr-island-lifecycle-");
  roots.push(root);
  const file = join(root, "Lifetime.island.tsx");
  writeFileSync(file, source);
  if (fallback) writeFileSync(join(root, "Fallback.tsx"), fallback);
  await buildIslands({
    pattern: "**/*.island.tsx",
    cwd: root,
    outdir: join(root, "_ssr"),
    dev: true,
    verbose: false,
    errorFallback: fallback ? join(root, "Fallback.tsx") : undefined,
  });
  const id = islandIdFromFile(file, root);
  return { id, load: (query = "") => import(join(root, "_ssr", `${id}.js${query}`)) };
};
const wrapper = (id: string, label = "one", tag = "solid-island") => {
  const element = document.createElement(tag);
  element.dataset.id = id;
  element.dataset.props = JSON.stringify(toJSON({ label }));
  element.textContent = "server HTML";
  return element;
};
const lifecycleSource = `
  import { onCleanup, onMount, createEffect } from "solid-js";
  const notify = (phase, label) => window.dispatchEvent(new CustomEvent("lifetime", { detail: phase + ":" + label }));
  export default function Lifetime(props) {
    onCleanup(() => notify("cleanup", props.label));
    createEffect(() => { onCleanup(() => notify("effect-cleanup", props.label)); });
    onMount(() => notify("mount", props.label));
    return <b>{props.label}</b>;
  }`;
const observeLifetime = () => {
  const events: string[] = [];
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) events.push(event.detail);
  };
  window.addEventListener("lifetime", listener);
  return { events, stop: () => window.removeEventListener("lifetime", listener) };
};

test("a loaded entry mounts late wrappers exactly once and respects root", async () => {
  const bundle = await build(`let renders = 0; export default () => <b>{++renders}</b>;`);
  await bundle.load();
  const root = wrapper(bundle.id);
  const outside = wrapper(bundle.id);
  const unloaded = wrapper("not-loaded", "unloaded", "solid-client");
  document.body.append(root, outside);
  mountIslands(root);
  const content = root.firstChild;
  mountIslands(root);
  expect(root.textContent).toBe("1");
  expect(outside.textContent).toBe("server HTML");
  const section = document.createElement("section");
  section.append(root, unloaded);
  document.body.append(section);
  mountIslands(section);
  expect(unloaded.textContent).toBe("server HTML");
  outside.remove();
  await bundle.load("?again");
  expect(root.firstChild).toBe(content);
  let duplicateRenders = 0;
  mount(() => {
    duplicateRenders++;
    return "duplicate";
  }, `solid-island[data-id="${bundle.id}"]`);
  mountIslands(root);
  expect(root.textContent).toBe("1");
  expect(duplicateRenders).toBe(0);
});

test("disposal notifies before each cleanup in document order and permits remounting", async () => {
  const bundle = await build(lifecycleSource);
  const section = document.createElement("section");
  const first = wrapper(bundle.id, "first");
  const second = wrapper(bundle.id, "second");
  const outside = wrapper(bundle.id, "outside");
  section.append(first, second);
  document.body.append(section, outside);
  const trace = observeLifetime();
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) throw new Error("Expected a custom event");
    expect(event.bubbles).toBe(true);
    expect(event.cancelable).toBe(false);
    expect(event.detail.id).toBe(bundle.id);
    expect(event.target === first || event.target === second).toBe(true);
    trace.events.push(`dispose:${event.target === first ? "first" : "second"}`);
  };
  await bundle.load();
  trace.events.length = 0;
  window.addEventListener("ssr:island-dispose", listener);
  try {
    disposeIslands(section);
    expect(trace.events).toEqual([
      "dispose:first",
      "effect-cleanup:first",
      "cleanup:first",
      "dispose:second",
      "effect-cleanup:second",
      "cleanup:second",
    ]);
    expect(first.childNodes.length).toBe(0);
    expect(second.childNodes.length).toBe(0);
    expect(outside.textContent).toBe("outside");
    mountIslands(section);
    expect(first.textContent).toBe("first");
    expect(second.textContent).toBe("second");
    expect(trace.events.slice(-2)).toEqual(["mount:first", "mount:second"]);
  } finally {
    window.removeEventListener("ssr:island-dispose", listener);
    trace.stop();
  }
});

test("50 cycles retain no window listeners, document listeners or intervals", async () => {
  const bundle = await build(`
    import { onMount, onCleanup } from "solid-js";
    export default function Lifetime() {
      onMount(() => {
        const resize = () => {};
        const keydown = () => {};
        window.addEventListener("resize", resize);
        document.addEventListener("keydown", keydown, true);
        const timer = setInterval(() => {}, 60000);
        onCleanup(() => {
          window.removeEventListener("resize", resize);
          document.removeEventListener("keydown", keydown, true);
          clearInterval(timer);
        });
      });
      return <b>ready</b>;
    }`);
  await bundle.load();
  const registrations: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; capture: boolean }[] = [];
  const targets: EventTarget[] = [window, document];
  for (const target of targets) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    spyOn(target, "addEventListener").mockImplementation((...[type, listener, options]: Parameters<EventTarget["addEventListener"]>) => {
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      if (
        listener &&
        !registrations.some(
          (item) => item.target === target && item.type === type && item.listener === listener && item.capture === capture,
        )
      ) {
        registrations.push({ target, type, listener, capture });
      }
      add(type, listener, options);
    });
    spyOn(target, "removeEventListener").mockImplementation(
      (...[type, listener, options]: Parameters<EventTarget["removeEventListener"]>) => {
        const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
        const index = registrations.findIndex(
          (item) => item.target === target && item.type === type && item.listener === listener && item.capture === capture,
        );
        if (index >= 0) registrations.splice(index, 1);
        remove(type, listener, options);
      },
    );
  }
  const intervals = new Set<unknown>();
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = new Proxy(interval, {
    apply(target, receiver: unknown, args: unknown[]) {
      const timer: unknown = Reflect.apply(target, receiver, args);
      intervals.add(timer);
      return timer;
    },
  });
  globalThis.clearInterval = new Proxy(clear, {
    apply(target, receiver: unknown, args: unknown[]) {
      intervals.delete(args[0]);
      return Reflect.apply(target, receiver, args);
    },
  });
  const cycle = () => {
    const element = wrapper(bundle.id);
    document.body.append(element);
    mountIslands(element);
    expect(registrations.filter((item) => item.type === "resize" || item.type === "keydown")).toHaveLength(2);
    expect(intervals.size).toBe(1);
    disposeIslands(element);
    element.remove();
  };
  try {
    cycle();
    const baseline = { listeners: registrations.length, intervals: intervals.size };
    for (let count = 0; count < 50; count++) cycle();
    expect({ listeners: registrations.length, intervals: intervals.size }).toEqual(baseline);
    expect(baseline).toEqual({ listeners: 0, intervals: 0 });
  } finally {
    globalThis.setInterval = interval;
    globalThis.clearInterval = clear;
  }
});

test.each(["default", "custom", "throwing custom"])("disposes the %s fallback and all Solid cleanups", async (kind) => {
  const fallback =
    kind === "default"
      ? undefined
      : `
    import { onCleanup } from "solid-js";
    export default function Fallback() {
      onCleanup(() => window.dispatchEvent(new CustomEvent("lifetime", { detail: "fallback-cleanup" })));
      ${kind === "throwing custom" ? 'throw new Error("fallback failed");' : 'return <p role="alert">Custom fallback</p>;'}
    }`;
  const bundle = await build(
    `
    import { onCleanup } from "solid-js";
    export default function Lifetime() {
      onCleanup(() => window.dispatchEvent(new CustomEvent("lifetime", { detail: "component-cleanup" })));
      throw new Error("first render failed");
    }`,
    fallback,
  );
  const element = wrapper(bundle.id);
  document.body.append(element);
  spyOn(globalThis, "reportError").mockImplementation(() => {});
  const trace = observeLifetime();
  try {
    await bundle.load();
    expect(element.querySelector("[role=alert]")).not.toBeNull();
    expect(() => disposeIslands(element)).not.toThrow();
    expect(element.childNodes.length).toBe(0);
    expect(trace.events.filter((event) => event === "component-cleanup")).toHaveLength(1);
    if (fallback) expect(trace.events.filter((event) => event === "fallback-cleanup")).toHaveLength(1);
  } finally {
    trace.stop();
  }
});

test("outer catch fallback disposes empty and Try again installs the Solid disposer", async () => {
  const bundle = await build(lifecycleSource);
  const broken = wrapper(bundle.id, "broken");
  const retry = wrapper(bundle.id, "retry");
  document.body.append(broken, retry);
  for (const element of [broken, retry]) {
    Object.defineProperty(element, "innerHTML", {
      configurable: true,
      set() {
        throw new Error("clearing failed");
      },
    });
  }
  spyOn(globalThis, "reportError").mockImplementation(() => {});
  await bundle.load();
  expect(() => disposeIslands(broken)).not.toThrow();
  expect(broken.childNodes.length).toBe(0);
  Reflect.deleteProperty(retry, "innerHTML");
  retry.querySelector("button")!.click();
  expect(retry.textContent).toBe("retry");
  const trace = observeLifetime();
  try {
    disposeIslands(retry);
    expect(trace.events).toEqual(["effect-cleanup:retry", "cleanup:retry"]);
    expect(retry.childNodes.length).toBe(0);
  } finally {
    trace.stop();
  }
});

test("a throwing cleanup is reported and later wrappers still dispose", async () => {
  const bundle = await build(`
    import { onCleanup } from "solid-js";
    export default function Lifetime(props) {
      onCleanup(() => { if (props.label === "broken") throw new Error("cleanup failed"); });
      return <b>{props.label}</b>;
    }`);
  const broken = wrapper(bundle.id, "broken");
  const healthy = wrapper(bundle.id, "healthy");
  document.body.append(broken, healthy);
  await bundle.load();
  const reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
  expect(() => disposeIslands(document)).not.toThrow();
  expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: "cleanup failed" }));
  expect(broken.childNodes.length).toBe(0);
  expect(healthy.childNodes.length).toBe(0);
  disposeIslands(document);
  expect(reported).toHaveBeenCalledTimes(1);
  mountIslands(broken);
  expect(broken.textContent).toBe("broken");
});
