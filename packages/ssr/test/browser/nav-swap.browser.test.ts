import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Window } from "happy-dom";
import { toJSON } from "seroval";
import { render } from "solid-js/web";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { disposeIslands, mountIslands } from "../../src/mount";
import { documentNavigate, installPageSwap, Link, listenPopState, navigate, navigateTo, refreshCurrentPath, swapPage } from "../../src/nav";
import { makeTempRoot } from "../temp-root";

let root: string;
let prefix: string;
let id: string;
let brokenId: string;
let slowId: string;
/** A second slow entry: an evaluated module stays cached, so each test that waits on loading needs its own. */
let laterId: string;
let historyId: string;
let scrollId: string;
let previousLoadingSettings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean };
let previousScrollY: PropertyDescriptor | undefined;
let uninstall = () => {};
const events: string[] = [];
const lifetime = (event: Event) => {
  if (event instanceof CustomEvent) events.push(event.detail);
};
const wrapper = (label: string, entry = id) =>
  `<solid-island data-id="${entry}" data-props='${JSON.stringify(toJSON({ label }))}'>server ${label}</solid-island>`;
const html = (label = "old", content = wrapper(label)) => `<!doctype html><html><head>
  <title>${label}</title><link rel="stylesheet" href="/base.css">
  <script data-ssr-assets="${prefix}" data-ssr-preload="shared.js"></script></head><body>
  <div data-nav-shell="sig" data-nav-scope="/app" data-nav-attributes="data-mode data-obsolete" data-mode="${label}" ${label === "old" ? 'data-obsolete="yes"' : ""}>
  <nav><a href="/app/A">A</a><a href="/app/B">B</a></nav>
  <main data-nav-root class="${label}"><h1>${label}</h1>${content}</main></div></body></html>`;
const response = (body = html("new"), options: ResponseInit = {}, url = "https://example.test/app/new") => {
  const result = new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...options });
  Object.defineProperties(result, { url: { value: url }, redirected: { value: url !== "https://example.test/app/new" } });
  return result;
};
const deferredFetch = (ignoreAbort = false) => {
  const requests: { signal: AbortSignal; aborted: boolean; resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (...[_url, options]: Parameters<typeof fetch>) =>
        new Promise<Response>((resolve, reject) => {
          const signal = options!.signal!;
          const request = { signal, aborted: false, resolve, reject };
          signal.addEventListener(
            "abort",
            () => {
              request.aborted = true;
              if (!ignoreAbort) reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          requests.push(request);
        }),
      { preconnect: fetch.preconnect },
    ),
  );
  return requests;
};
const click = (href: string, attributes = "", options: MouseEventInit = {}) => {
  const anchor = document.createElement("a");
  anchor.href = href;
  if (attributes) {
    const template = document.createElement("template");
    template.innerHTML = `<a ${attributes}></a>`;
    for (const attr of template.content.firstElementChild!.attributes) anchor.setAttribute(attr.name, attr.value);
  }
  document.body.append(anchor);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
  anchor.dispatchEvent(event);
  anchor.remove();
  return event;
};
let assign: ReturnType<typeof spyOn<Location, "assign">>;
let replace: ReturnType<typeof spyOn<Location, "replace">>;
beforeAll(async () => {
  root = makeTempRoot(".ssr-nav-swap-");
  prefix = join(root, "_ssr");
  const file = join(root, "Page.island.tsx");
  const broken = join(root, "Broken.island.tsx");
  const slow = join(root, "Slow.island.tsx");
  writeFileSync(
    file,
    `import { onMount, onCleanup } from "solid-js";
    export default function Page(props) {
      onMount(() => {
        const listener = () => {};
        window.addEventListener("resize", listener);
        document.addEventListener("nav-probe", listener);
        window.dispatchEvent(new CustomEvent("nav-lifetime", {detail: "mount:" + props.label}));
        onCleanup(() => {
          window.removeEventListener("resize", listener);
          document.removeEventListener("nav-probe", listener);
          window.dispatchEvent(new CustomEvent("nav-lifetime", {detail: "cleanup:" + props.label}));
        });
      });
      return <b>{props.label}</b>;
    }`,
  );
  writeFileSync(broken, `throw new Error("entry evaluation failed"); export default () => <b>unreachable</b>;`);
  writeFileSync(
    slow,
    `await new Promise(resolve => {
    window.addEventListener("nav-module-release", resolve, { once: true });
    window.dispatchEvent(new Event("nav-module-loading"));
  }); export default () => <b>slow mounted</b>;`,
  );
  slowId = islandIdFromFile(slow, root);
  const later = join(root, "Later.island.tsx");
  writeFileSync(later, readFileSync(slow, "utf8"));
  laterId = islandIdFromFile(later, root);
  const history = join(root, "History.island.tsx");
  writeFileSync(
    history,
    `import { onMount } from "solid-js";
    export default function History() {
      onMount(() => window.history.replaceState({ island: 1 }, ""));
      return <b>island history</b>;
    }`,
  );
  historyId = islandIdFromFile(history, root);
  const scroll = join(root, "Scroll.island.tsx");
  writeFileSync(
    scroll,
    `export default function Scroll(props) {
      return <div data-scroll-preserve="list" style="height: 50px; overflow: auto"><div style="height: 500px">{props.label}</div></div>;
    }`,
  );
  scrollId = islandIdFromFile(scroll, root);
  id = islandIdFromFile(file, root);
  brokenId = islandIdFromFile(broken, root);
  await buildIslands({ pattern: "**/*.island.tsx", cwd: root, outdir: prefix, dev: true, verbose: false });
});
beforeEach(async () => {
  previousScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
  window.sessionStorage.removeItem(scrollKey);
  const settings = (window as unknown as Window).happyDOM.settings;
  previousLoadingSettings = {
    disableCSSFileLoading: settings.disableCSSFileLoading,
    handleDisabledFileLoadingAsSuccess: settings.handleDisabledFileLoadingAsSuccess,
  };
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
  (window as unknown as Window).happyDOM.setURL("https://example.test/app/old");
  window.history.replaceState(null, "", "/app/old");
  const parsed = new DOMParser().parseFromString(html(), "text/html");
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
  replace = spyOn(window.location, "replace").mockImplementation(() => {});
  spyOn(window, "scrollTo").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("nav-lifetime", lifetime);
  await import(`${prefix}/${id}.js?initial`);
  // A cached entry still uses the shared registry for the next fixture.
  const { mountIslands } = await import("../../src/mount");
  mountIslands(document);
  events.length = 0;
});
afterEach(() => {
  uninstall();
  uninstall = () => {};
  disposeIslands(document);
  window.removeEventListener("nav-lifetime", lifetime);
  document.body.replaceChildren();
  document.head.replaceChildren();
  mock.restore();
  if (previousScrollY) Object.defineProperty(window, "scrollY", previousScrollY);
  else Reflect.deleteProperty(window, "scrollY");
  Object.assign((window as unknown as Window).happyDOM.settings, previousLoadingSettings);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const install = () => {
  uninstall = installPageSwap();
};

test("without install anchors stay native and programmatic swap loads one document", async () => {
  const fetch = spyOn(globalThis, "fetch");
  expect(click("/app/A").defaultPrevented).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  await swapPage("/app/A");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/A");
});

test("install stamps a null-state entry without adding history", () => {
  const before = window.history.length;
  install();
  expect(window.history.state["@k2b/ssr/nav"].page).toMatch(/:1$/);
  expect(window.history.length).toBe(before);
  expect(window.location.pathname).toBe("/app/old");
});

test("install preserves island state while marking the entry", () => {
  window.history.replaceState({ island: 1 }, "");
  install();
  expect(window.history.state).toEqual({ island: 1, "@k2b/ssr/nav": { page: expect.any(String), position: window.history.length - 1 } });
});

const markerKey = "@k2b/ssr/nav";
const scrollKey = "@k2b/ssr/nav:scroll";
const arrive = (state: unknown, url = "/app/old") => {
  History.prototype.replaceState.call(window.history, state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
};
const swapped = (label: string): Promise<void> =>
  new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-nav-announcer]")?.textContent !== label) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true });
  });

test("reinstall keeps the shown page id and swaps an unmarked entry", async () => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  await swapPage("/app/new");
  const page = window.history.state[markerKey].page;
  uninstall();
  install();
  expect(window.history.state[markerKey].page).toBe(page);
  const done = swapped("old");
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("old"), {}, "https://example.test/app/old"));
  arrive({ island: 1 });
  await done;
  expect(window.history.state.island).toBe(1);
  expect(window.history.state[markerKey].page).not.toBe(page);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("rapid A then B aborts A and only B mounts and commits", async () => {
  install();
  const requests = deferredFetch();
  const a = swapPage("/app/A");
  const b = swapPage("/app/B");
  expect(requests[0]!.aborted).toBe(true);
  requests[1]!.resolve(response(html("B"), {}, "https://example.test/app/B"));
  await Promise.all([a, b]);
  expect(window.location.pathname).toBe("/app/B");
  expect(document.title).toBe("B");
  expect(document.querySelector("main b")!.textContent).toBe("B");
  expect(events).toEqual(["cleanup:old", "mount:B"]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

const failures = [
  ["non-HTML", () => response("plain", { headers: { "content-type": "text/plain" } })],
  ["403", () => response(html(), { status: 403 })],
  ["redirect out of scope", () => response(html(), {}, "https://example.test/login")],
  ["redirect cross-origin", () => response(html(), {}, "https://other.test/app/new")],
  ["signature mismatch", () => response(html("new").replace('data-nav-shell="sig"', 'data-nav-shell="other"'))],
  ["scope mismatch", () => response(html("new").replace('data-nav-scope="/app"', 'data-nav-scope="/"'))],
  ["module prefix mismatch", () => response(html("new").replace(prefix, `${prefix}/v2`))],
  ["stylesheet set change", () => response(html("new").replace("/base.css", "/other.css"))],
  ["missing root", () => response(html("new").replace("data-nav-root", "data-other-root"))],
  ["missing shell", () => response(html("new").replace("data-nav-shell", "data-other-shell"))],
  ["missing module prefix", () => response(html("new").replace(`data-ssr-assets="${prefix}"`, ""))],
] as const;
test.each(failures)("%s falls back once with the mounted old column and history intact", async (_name, make) => {
  install();
  const old = document.querySelector("main");
  const before = window.history.length;
  spyOn(globalThis, "fetch").mockResolvedValue(make());
  await swapPage("/app/requested");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/requested");
  expect(replace).not.toHaveBeenCalled();
  expect(document.querySelector("main")).toBe(old);
  expect(old!.querySelector("b")!.textContent).toBe("old");
  expect(events).toEqual([]);
  expect(window.history.length).toBe(before);
  expect(window.location.pathname).toBe("/app/old");
  expect(console.error).not.toHaveBeenCalled();
});

test.each(["evaluation throw", "404"])("module %s keeps old islands alive until one document load", async (kind) => {
  install();
  const old = document.querySelector("main");
  assign.mockImplementation(() => {
    expect(document.querySelector("main")).toBe(old);
    expect(old!.querySelector("b")!.textContent).toBe("old");
    expect(events).toEqual([]);
  });
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", kind === "404" ? "missing" : brokenId))));
  await swapPage("/app/requested");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/requested");
  expect(console.error).toHaveBeenCalledTimes(1);
});

test.each([
  ["meta", "", { metaKey: true }],
  ["ctrl", "", { ctrlKey: true }],
  ["shift", "", { shiftKey: true }],
  ["alt", "", { altKey: true }],
  ["middle", "", { button: 1 }],
  ["blank", 'target="_blank"', {}],
  ["download", "download", {}],
  ["external", 'rel="external"', {}],
  ["opt-out", "data-nav-document", {}],
] as const)("does not take %s clicks", (_name, attributes, options) => {
  install();
  const fetch = spyOn(globalThis, "fetch");
  expect(click("/app/A", attributes, options).defaultPrevented).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
test.each(["https://other.test/app/A", "/appbox", "/app/old#heading", "#"])("does not take %s", (href) => {
  install();
  const fetch = spyOn(globalThis, "fetch");
  expect(click(href).defaultPrevented).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
test("anchor and document-delegated handlers can prevent the swap; non-Element and SVG targets are ignored", () => {
  install();
  const fetch = spyOn(globalThis, "fetch");
  const anchor = document.querySelector("a")!;
  anchor.addEventListener("click", (event) => event.preventDefault(), { once: true });
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const prevent = (event: Event) => event.preventDefault();
  document.addEventListener("click", prevent, { once: true });
  expect(click("/app/A").defaultPrevented).toBe(true);
  window.dispatchEvent(new MouseEvent("click"));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "a");
  svg.setAttribute("href", "/app/A");
  document.body.append(svg);
  svg.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(fetch).not.toHaveBeenCalled();
});

test("success disposes, mounts, copies attributes, commits history, focuses and announces", async () => {
  install();
  let disposed = 0;
  const dispose = () => {
    disposed++;
  };
  window.addEventListener("ssr:island-dispose", dispose);
  try {
    const before = window.history.length;
    spyOn(globalThis, "fetch").mockResolvedValue(response());
    await swapPage("/app/new");
    expect(document.title).toBe("new");
    expect(window.history.state["@k2b/ssr/nav"].page).toMatch(/:2$/);
    expect(window.history.length).toBe(before + 1);
    expect(document.querySelector("[data-nav-shell]")!.getAttribute("data-mode")).toBe("new");
    expect(document.querySelector("[data-nav-shell]")!.hasAttribute("data-obsolete")).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("main h1"));
    expect(document.activeElement!.getAttribute("tabindex")).toBe("-1");
    expect(document.querySelector("[data-nav-announcer]")!.textContent).toBe("new");
    expect(disposed).toBe(1);
    expect(events).toEqual(["cleanup:old", "mount:new"]);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.querySelectorAll('link[rel="modulepreload"]')).toHaveLength(1);
    await swapPage("/app/new", { replace: true });
    expect(window.history.length).toBe(before + 1);
    expect(document.querySelectorAll('link[rel="modulepreload"]')).toHaveLength(1);
  } finally {
    window.removeEventListener("ssr:island-dispose", dispose);
  }
});

test("50 sequential swaps keep listener counts flat and dispose every previous island", async () => {
  install();
  const counts = { window: 0, document: 0 };
  const targets: [keyof typeof counts, EventTarget][] = [
    ["window", window],
    ["document", document],
  ];
  for (const [name, target] of targets) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    spyOn(target, "addEventListener").mockImplementation((...args: Parameters<EventTarget["addEventListener"]>) => {
      counts[name]++;
      add(...args);
    });
    spyOn(target, "removeEventListener").mockImplementation((...args: Parameters<EventTarget["removeEventListener"]>) => {
      counts[name]--;
      remove(...args);
    });
  }
  const baseline = { ...counts };
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async (href: Parameters<typeof fetch>[0]) => response(html(String(href).endsWith("A") ? "A" : "B"), {}, String(href)), {
      preconnect: fetch.preconnect,
    }),
  );
  for (let index = 0; index < 50; index++) {
    await swapPage(`/app/${index % 2 ? "A" : "B"}`);
    expect(counts).toEqual(baseline);
  }
  expect(events.filter((event) => event.startsWith("cleanup:"))).toHaveLength(50);
});

test("same-page popstate stays with islands; cross-page popstate aborts a pending swap", async () => {
  install();
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  expect(reload).not.toHaveBeenCalled();
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  const done = swapped("B");
  arrive({ [markerKey]: { page: "other", position: 5 } }, "/app/B#section");
  await pending;
  expect(requests[0]!.aborted).toBe(true);
  requests[1]!.resolve(response(html("B"), {}, "https://example.test/app/B"));
  await done;
  expect(window.history.state[markerKey]).toEqual({ page: "other", position: 5 });
  expect(reload).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

test("install is idempotent; uninstall removes listeners, live region and pending work", async () => {
  const add = spyOn(window, "addEventListener");
  const remove = spyOn(window, "removeEventListener");
  install();
  expect(installPageSwap()).toBe(uninstall);
  expect(add.mock.calls.filter(([type]) => type === "click" || type === "submit" || type === "popstate")).toHaveLength(4);
  expect(add).toHaveBeenCalledWith("click", expect.any(Function), true);
  expect(add).toHaveBeenCalledWith("submit", expect.any(Function), true);
  expect(document.querySelectorAll("[data-nav-announcer]")).toHaveLength(1);
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  uninstall();
  await pending;
  expect(requests[0]!.aborted).toBe(true);
  expect(remove.mock.calls.filter(([type]) => type === "click" || type === "submit" || type === "popstate")).toHaveLength(4);
  const capture = add.mock.calls.find(([type, , options]) => type === "click" && options === true)![1];
  expect(remove).toHaveBeenCalledWith("click", capture, true);
  const submit = add.mock.calls.find(([type]) => type === "submit")![1];
  expect(remove).toHaveBeenCalledWith("submit", submit, true);
  expect(document.querySelector("[data-nav-announcer]")).toBeNull();
  expect(assign).not.toHaveBeenCalled();
});

test("a native same-tab link aborts pending work without causing an extra document load", async () => {
  install();
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  expect(click("/outside").defaultPrevented).toBe(false);
  await pending;
  expect(requests[0]!.aborted).toBe(true);
  expect(assign).not.toHaveBeenCalled();
});

test("a native link that stops propagation prevents a pending swap from committing or loading a document", async () => {
  install();
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  const anchor = document.createElement("a");
  anchor.href = "/outside";
  anchor.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(anchor);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  const nativeUrl = window.location.href;
  const before = window.history.length;
  const state = window.history.state;
  expect(requests[0]!.signal.aborted).toBe(false);
  requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
  await pending;
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(document.title).toBe("old");
  expect(window.location.href).toBe(nativeUrl);
  expect(window.history.length).toBe(before);
  expect(window.history.state).toEqual(state);
  expect(events).toEqual([]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a prevented link that stops propagation lets a pending swap commit", async () => {
  install();
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  const anchor = document.createElement("a");
  anchor.href = "/outside";
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  document.body.append(anchor);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  const before = window.history.length;
  requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
  await pending;
  expect(requests[0]!.signal.aborted).toBe(false);
  expect(document.title).toBe("A");
  expect(window.location.pathname).toBe("/app/A");
  expect(window.history.length).toBe(before + 1);
  expect(events).toEqual(["cleanup:old", "mount:A"]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test.each([false, true])("a native same-tab form submission with stopPropagation=%s stops a pending swap", async (stop) => {
  install();
  const requests = deferredFetch(true);
  const before = window.history.length;
  const state = window.history.state;
  const pending = swapPage("/app/A");
  const form = document.createElement("form");
  if (stop) form.addEventListener("submit", (event) => event.stopPropagation());
  document.body.append(form);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
  await pending;
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(document.title).toBe("old");
  expect(document.querySelector("main b")!.textContent).toBe("old");
  expect(window.location.href).toBe("https://example.test/app/old");
  expect(window.history.length).toBe(before);
  expect(window.history.state).toEqual(state);
  expect(events).toEqual([]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test.each(["prevented", "_blank", "dialog"])("a %s form submission lets a pending swap commit", async (kind) => {
  install();
  const requests = deferredFetch(true);
  const pending = swapPage("/app/A");
  const form = document.createElement("form");
  if (kind === "_blank") form.target = "_blank";
  else if (kind === "dialog") form.method = "dialog";
  else form.addEventListener("submit", (event) => event.preventDefault());
  document.body.append(form);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(requests[0]!.signal.aborted).toBe(false);
  requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
  await pending;
  expect(document.title).toBe("A");
  expect(window.location.pathname).toBe("/app/A");
  expect(events).toEqual(["cleanup:old", "mount:A"]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("an aborted module import can finish later without inserting or mounting its page", async () => {
  install();
  const loading = Promise.withResolvers<void>();
  const listener = () => loading.resolve();
  window.addEventListener("nav-module-loading", listener, { once: true });
  try {
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(html("A", wrapper("A", slowId))))
      .mockResolvedValueOnce(response(html("B"), {}, "https://example.test/app/B"));
    const a = swapPage("/app/A");
    await loading.promise;
    expect(document.querySelector("main b")!.textContent).toBe("old");
    await swapPage("/app/B");
    window.dispatchEvent(new Event("nav-module-release"));
    await a;
    expect(window.location.pathname).toBe("/app/B");
    expect(document.querySelector("main b")!.textContent).toBe("B");
    expect(events).toEqual(["cleanup:old", "mount:B"]);
    expect(assign).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("nav-module-loading", listener);
    window.dispatchEvent(new Event("nav-module-release"));
  }
});

test("a column replaced while modules load falls back once without committing history", async () => {
  install();
  const loading = Promise.withResolvers<void>();
  const listener = () => loading.resolve();
  window.addEventListener("nav-module-loading", listener, { once: true });
  try {
    spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", laterId))));
    const before = window.history.length;
    const pending = swapPage("/app/requested");
    await loading.promise;
    const replacement = document.createElement("main");
    document.querySelector("main")!.replaceWith(replacement);
    window.dispatchEvent(new Event("nav-module-release"));
    await pending;
    expect(document.querySelector("main")).toBe(replacement);
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/app/old");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://example.test/app/requested");
  } finally {
    window.removeEventListener("nav-module-loading", listener);
    window.dispatchEvent(new Event("nav-module-release"));
  }
});

test("commit failure after push replaces the requested document exactly once", async () => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  spyOn(window, "scrollTo").mockImplementation(() => {
    throw new Error("commit scroll failed");
  });
  const before = window.history.length;
  await swapPage("/app/requested");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledWith("https://example.test/app/requested");
  expect(window.history.length).toBe(before + 1);
});

test.each(["shell", "root", "scope", "origin", "scope boundary"])(
  "programmatic %s ineligibility loads the resolved URL once",
  async (kind) => {
    install();
    if (kind === "shell") document.querySelector("[data-nav-shell]")!.removeAttribute("data-nav-shell");
    if (kind === "root") document.querySelector("[data-nav-root]")!.removeAttribute("data-nav-root");
    if (kind === "scope") document.querySelector("[data-nav-shell]")!.removeAttribute("data-nav-scope");
    const href = kind === "origin" ? "https://other.test/app/A" : kind === "scope boundary" ? "/appbox" : "A";
    const fetch = spyOn(globalThis, "fetch");
    await swapPage(href, { replace: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(new URL(href, "https://example.test/app/old").href);
  },
);

test("in-scope clicks are prevented and same-URL clicks replace history", async () => {
  install();
  const requests = deferredFetch();
  const before = window.history.length;
  expect(click("/app/old").defaultPrevented).toBe(true);
  const committed = swapped("new");
  requests[0]!.resolve(response(html("new"), {}, "https://example.test/app/old"));
  await committed;
  expect(window.history.length).toBe(before);
  expect(document.querySelector("main b")!.textContent).toBe("new");
  expect(assign).not.toHaveBeenCalled();
});

test.each(["fetch", "body read"])("a thrown %s failure preserves the column and falls back once", async (phase) => {
  install();
  const old = document.querySelector("main");
  const fetch = spyOn(globalThis, "fetch");
  if (phase === "fetch") fetch.mockRejectedValue(new Error("network failed"));
  else {
    const result = response();
    spyOn(result, "text").mockRejectedValue(new Error("body read failed"));
    fetch.mockResolvedValue(result);
  }
  await swapPage("/app/requested");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/requested");
  expect(document.querySelector("main")).toBe(old);
  expect(events).toEqual([]);
  expect(console.error).toHaveBeenCalledTimes(1);
});

test("a stale body read cannot commit after the next page", async () => {
  install();
  const reading = Promise.withResolvers<void>();
  const body = Promise.withResolvers<string>();
  const result = response();
  spyOn(result, "text").mockImplementation(() => {
    reading.resolve();
    return body.promise;
  });
  spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce(response(html("B"), {}, "https://example.test/app/B"));
  const a = swapPage("/app/A");
  await reading.promise;
  await swapPage("/app/B");
  body.resolve(html("A"));
  await a;
  expect(document.title).toBe("B");
  expect(events).toEqual(["cleanup:old", "mount:B"]);
  expect(assign).not.toHaveBeenCalled();
});

test.each(["/app", "/app/", "/app/x", "/app?x"])("scope accepts %s at a path boundary", async (href) => {
  install();
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response(html("new"), {}, new URL(href, document.baseURI).href));
  await swapPage(href);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(new URL(href, "https://example.test/app/old").href, {
    credentials: "same-origin",
    signal: expect.any(AbortSignal),
    headers: { Accept: "text/html" },
  });
  expect(document.title).toBe("new");
  expect(assign).not.toHaveBeenCalled();
});

test("root scope, absent prefixes without wrappers, and the same stylesheet spelled absolute are compatible", async () => {
  install();
  document.querySelector("[data-nav-shell]")!.setAttribute("data-nav-scope", "/");
  document.querySelector("script[data-ssr-assets]")!.remove();
  const next = html("new", "")
    .replace('data-nav-scope="/app"', 'data-nav-scope="/"')
    .replace(`<script data-ssr-assets="${prefix}" data-ssr-preload="shared.js"></script>`, "")
    .replace('<link rel="stylesheet" href="/base.css">', '<link rel="stylesheet" href="https://example.test/base.css">');
  spyOn(globalThis, "fetch").mockResolvedValue(response(next, {}, "https://example.test/elsewhere"));
  await swapPage("/elsewhere");
  expect(window.location.pathname).toBe("/elsewhere");
  expect(assign).not.toHaveBeenCalled();
});

test("redirect commits the final path and query with the requested hash and focuses the root without headings", async () => {
  install();
  const next = html("new", '<p id="destination">target</p>').replace("<h1>new</h1>", "");
  spyOn(globalThis, "fetch").mockResolvedValue(response(next, {}, "https://example.test/app/final?x=1#ignored"));
  const scroll = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await swapPage("/app/requested#destination");
  expect(window.location.href).toBe("https://example.test/app/final?x=1#destination");
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(document.querySelector("main"));
  expect(document.activeElement!.getAttribute("tabindex")).toBe("-1");
  expect(assign).not.toHaveBeenCalled();
});

test("programmatic swap never rejects even when the browser refuses document navigation", async () => {
  assign.mockImplementation(() => {
    throw new Error("navigation refused");
  });
  await expect(swapPage("/app/A")).resolves.toBeUndefined();
  expect(assign).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledTimes(1);
});

test("independent module copies share one document installation", async () => {
  install();
  const copy = await import(join(import.meta.dir, "../../src/nav-swap.ts?second-copy"));
  expect(copy.installPageSwap()).toBe(uninstall);
  expect(document.querySelectorAll("[data-nav-announcer]")).toHaveLength(1);
});

test.each(["replace root", "uninstall"])("disposal can %s without committing the requested page", async (action) => {
  install();
  const before = window.history.length;
  const oldUrl = window.location.href;
  const replacement = document.createElement("main");
  const dispose = () => {
    if (action === "uninstall") uninstall();
    else document.querySelector("main")!.replaceWith(replacement);
  };
  window.addEventListener("ssr:island-dispose", dispose, { once: true });
  try {
    spyOn(globalThis, "fetch").mockResolvedValue(response());
    await swapPage("/app/requested");
    // Application cleanup invalidates ownership before history, title or the root may commit.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://example.test/app/requested");
    expect(replace).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
    expect(window.location.href).toBe(oldUrl);
    expect(document.title).toBe("old");
    expect(events).toEqual(["cleanup:old"]);
    if (action === "replace root") expect(document.querySelector("main")).toBe(replacement);
  } finally {
    window.removeEventListener("ssr:island-dispose", dispose);
  }
});

test("a swap that a cleanup starts cannot stop the commit and then loads its document", async () => {
  install();
  const requests = deferredFetch();
  let b = Promise.resolve();
  const dispose = () => {
    b = swapPage("/app/B");
  };
  window.addEventListener("ssr:island-dispose", dispose, { once: true });
  try {
    const a = swapPage("/app/A");
    requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
    await a;
    // A commits completely: no disposed column is left waiting for B.
    expect(requests).toHaveLength(2);
    expect(window.location.pathname).toBe("/app/A");
    expect(document.title).toBe("A");
    expect(document.querySelector("main b")!.textContent).toBe("A");
    requests[1]!.resolve(response(html("B"), {}, "https://example.test/app/B"));
    await b;
    // B captured the column A replaced, so it cannot swap and loads its document once.
    expect(window.location.pathname).toBe("/app/A");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://example.test/app/B");
    expect(replace).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("ssr:island-dispose", dispose);
  }
});

test.each(["navigate", "Link push"])("newer %s cancels a pending swap and keeps the island URL", async (kind) => {
  install();
  const old = document.querySelector("main");
  const requests = deferredFetch(true);
  const pending = swapPage("/app/A");
  const linkRoot = document.createElement("div");
  document.querySelector("nav")!.append(linkRoot);
  let dispose = () => {};
  try {
    if (kind === "navigate") navigate("/app/island");
    else {
      dispose = render(() => Link({ href: "/app/island", onNavigate: ({ push }) => push(), children: "island" }), linkRoot);
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      linkRoot.querySelector("a")!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(window.location.pathname).toBe("/app/island");
    requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
    await pending;
    expect(window.location.href).toBe("https://example.test/app/island");
    expect(document.querySelector("main")).toBe(old);
    expect(old!.querySelector("b")!.textContent).toBe("old");
    expect(document.title).toBe("old");
    expect(events).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  } finally {
    dispose();
    linkRoot.remove();
  }
});

test.each([
  ["documentNavigate", () => documentNavigate("/x"), "/x"],
  ["navigateTo", () => navigateTo("/y"), "/y"],
  ["refreshCurrentPath", () => refreshCurrentPath(), "/app/old"],
] as const)("%s aborts a pending swap and produces only its own document load", async (_name, go, href) => {
  install();
  const requests = deferredFetch(true);
  const pending = swapPage("/app/A");
  go();
  expect(requests[0]!.signal.aborted).toBe(true);
  requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
  await pending;
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith(href);
  expect(replace).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/app/old");
  expect(document.title).toBe("old");
  expect(document.querySelector("main b")!.textContent).toBe("old");
  expect(events).toEqual([]);
});

test("a malformed hash escape commits without document navigation", async () => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  await swapPage("/app/new#%");
  expect(window.location.href).toBe("https://example.test/app/new#%");
  expect(document.title).toBe("new");
  expect(document.querySelector("main b")!.textContent).toBe("new");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a late commit failure replaces even when a new island replaces history state", async () => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", historyId))));
  const focus = spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {
    throw new Error("commit focus failed");
  });
  const before = window.history.length;
  await swapPage("/app/requested");
  expect(window.history.state).toEqual({ island: 1, [markerKey]: { page: expect.any(String), position: expect.any(Number) } });
  expect(window.history.length).toBe(before + 1);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledWith("https://example.test/app/requested");
  expect(assign).not.toHaveBeenCalled();
});

test("base target blank keeps an in-scope click native without fetching", () => {
  install();
  const base = document.createElement("base");
  base.target = "_blank";
  document.head.prepend(base);
  const fetch = spyOn(globalThis, "fetch");
  expect(click("/app/A").defaultPrevented).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test.each(["_top", "_parent"])("a native %s click aborts a pending swap", async (target) => {
  install();
  const requests = deferredFetch(true);
  const pending = swapPage("/app/A");
  expect(click("/app/B", `target="${target}"`).defaultPrevented).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(true);
  // Happy DOM applies the native target navigation itself; the late swap must leave that URL alone.
  const nativeUrl = window.location.href;
  requests[0]!.resolve(response(html("A"), {}, "https://example.test/app/A"));
  await pending;
  expect(window.location.href).toBe(nativeUrl);
  expect(document.title).toBe("old");
  expect(document.querySelector("main b")!.textContent).toBe("old");
  expect(events).toEqual([]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("both page bases resolve relative stylesheets while history commits an absolute same-origin URL", async () => {
  install();
  const base = document.createElement("base");
  base.href = "https://other.test/";
  document.head.prepend(base);
  document.querySelector('link[rel="stylesheet"]')!.setAttribute("href", "base.css");
  const next = html("new").replace("<head>", '<head><base href="https://other.test/">').replace('href="/base.css"', 'href="base.css"');
  spyOn(globalThis, "fetch").mockResolvedValue(response(next));
  await swapPage("https://example.test/app/new");
  // Happy DOM resolves relative history URLs against location instead of <base>; require the browser-safe absolute input.
  expect(window.history.state[markerKey]).toEqual({ page: expect.any(String), position: window.history.length - 1 });
  expect(window.location.href).toBe("https://example.test/app/new");
  expect(document.title).toBe("new");
  expect(document.querySelector("main b")!.textContent).toBe("new");
  expect(events).toEqual(["cleanup:old", "mount:new"]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a composed click reaches an anchor inside a shell shadow root", async () => {
  install();
  const requests = deferredFetch();
  const host = document.createElement("div");
  document.querySelector("[data-nav-shell]")!.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const anchor = document.createElement("a");
  anchor.href = "/app/shadow";
  shadow.append(anchor);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0 });
  // Happy DOM keeps the inner target across shadow boundaries; model the host that a window listener sees in a browser.
  Object.defineProperty(event, "target", { get: () => host });
  anchor.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(requests).toHaveLength(1);
  expect(globalThis.fetch).toHaveBeenCalledWith("https://example.test/app/shadow", {
    credentials: "same-origin",
    signal: requests[0]!.signal,
    headers: { Accept: "text/html" },
  });
  requests[0]!.resolve(response(html("shadow"), {}, "https://example.test/app/shadow"));
  // Join the click-started swap through its synchronous commit's last observable step.
  await new Promise<void>((resolve) => {
    const focus = HTMLElement.prototype.focus;
    spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      focus.call(this, options);
      resolve();
    });
  });
  expect(window.location.pathname).toBe("/app/shadow");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a keyed region created by an island restores its scroll after the new island mounts", async () => {
  install();
  spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response(html("list-old", wrapper("list-old", scrollId)), {}, "https://example.test/app/list-old"))
    .mockResolvedValueOnce(response(html("list-new", wrapper("list-new", scrollId)), {}, "https://example.test/app/list-new"));
  await swapPage("/app/list-old");
  const old = document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!;
  old.scrollTop = 125;
  expect(old.scrollTop).toBe(125);
  await swapPage("/app/list-new");
  const next = document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!;
  expect(next).not.toBe(old);
  expect(old.isConnected).toBe(false);
  expect(next.textContent).toBe("list-new");
  // The response contains only a wrapper: this region exists only after mountIslands, so 125 proves restoration ran later.
  expect(next.scrollTop).toBe(125);
  expect(window.location.pathname).toBe("/app/list-new");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a valid swap page served as JSON falls back solely on its content type", async () => {
  install();
  const before = window.history.length;
  const old = document.querySelector("main");
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new"), { headers: { "content-type": "application/json" } }));
  await swapPage("/app/new");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/new");
  expect(replace).not.toHaveBeenCalled();
  expect(window.history.length).toBe(before);
  expect(window.location.pathname).toBe("/app/old");
  expect(document.title).toBe("old");
  expect(document.querySelector("main")).toBe(old);
  expect(events).toEqual([]);
});

test("a fetch ignoring abort cannot read or commit A after B has committed", async () => {
  install();
  const requests = deferredFetch(true);
  const a = swapPage("/app/A");
  const b = swapPage("/app/B");
  expect(requests[0]!.signal.aborted).toBe(true);
  requests[1]!.resolve(response(html("B"), {}, "https://example.test/app/B"));
  await b;
  const column = document.querySelector("main");
  const before = window.history.length;
  const stale = response(html("A"), {}, "https://example.test/app/A");
  const read = spyOn(stale, "text");
  requests[0]!.resolve(stale);
  await a;
  // This isolates the post-fetch guard; later stale checks could hide its removal if we checked only the final DOM.
  expect(read).not.toHaveBeenCalled();
  expect(window.location.href).toBe("https://example.test/app/B");
  expect(document.title).toBe("B");
  expect(document.querySelector("main")).toBe(column);
  expect(column!.querySelector("b")!.textContent).toBe("B");
  expect(window.history.length).toBe(before);
  expect(events).toEqual(["cleanup:old", "mount:B"]);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test.each([
  ["rel=EXTERNAL", 'rel="EXTERNAL"', false],
  ["target=_SELF", 'target="_SELF"', true],
] as const)("normalizes %s", (_name, attributes, taken) => {
  install();
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: globalThis.fetch.preconnect }),
  );
  expect(click("/app/A", attributes).defaultPrevented).toBe(taken);
  expect(fetch).toHaveBeenCalledTimes(taken ? 1 : 0);
});

test("an explicit empty target stays in this tab under <base target>", () => {
  install();
  const base = document.createElement("base");
  base.target = "_blank";
  document.head.append(base);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: globalThis.fetch.preconnect }),
  );
  expect(click("/app/A", 'target=""').defaultPrevented).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a fetched page with another <base> loads as a document", async () => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new").replace("<head>", '<head><base href="/assets/">')));
  await swapPage("/app/new");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/new");
  expect(document.title).toBe("old");
});

test("an enhanced Link cancels a pending swap when it takes the click, before its handler loads", async () => {
  install();
  const requests = deferredFetch();
  const loaded = Promise.withResolvers<void>();
  const linkRoot = document.createElement("div");
  document.querySelector("nav")!.append(linkRoot);
  const dispose = render(
    () =>
      Link({
        href: "/app/island",
        onNavigate: async ({ push }) => {
          await loaded.promise;
          push();
        },
        children: "island",
      }),
    linkRoot,
  );
  try {
    const pending = swapPage("/app/A");
    linkRoot.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(requests[0]!.aborted).toBe(true);
    await pending;
    loaded.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.location.pathname).toBe("/app/island");
    expect(document.querySelector("main b")!.textContent).toBe("old");
    expect(assign).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

test.each([
  [
    "order",
    '<link rel="stylesheet" href="/second.css"><link rel="stylesheet" href="/base.css">',
    '<link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/second.css">',
  ],
  ["media", '<link rel="stylesheet" href="/base.css">', '<link rel="stylesheet" href="/base.css" media="print">'],
] as const)("a stylesheet %s change loads the document", async (_name, current, fetched) => {
  install();
  document.head.querySelector('link[rel="stylesheet"]')!.outerHTML = current;
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new").replace('<link rel="stylesheet" href="/base.css">', fetched)));
  await swapPage("/app/new");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/new");
  expect(document.title).toBe("old");
});

test("relative head stylesheets keep where they loaded after a swap into another directory", async () => {
  document.querySelector('link[rel="stylesheet"]')!.setAttribute("href", "theme.css");
  install();
  const page = (label: string, href: string) => html(label).replace('href="/base.css"', `href="${href}"`);
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response(page("new", "../theme.css"), {}, "https://example.test/app/sub/new"));
  await swapPage("/app/sub/new");
  expect(window.location.pathname).toBe("/app/sub/new");
  // The kept sheet is still /app/theme.css: `theme.css` from here would be /app/sub/theme.css.
  fetch.mockResolvedValue(response(page("other", "theme.css"), {}, "https://example.test/app/sub/other"));
  await swapPage("/app/sub/other");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/sub/other");
  expect(document.title).toBe("new");
});

test("an early 403 on the current URL with a hash reloads without changing history", async () => {
  install();
  window.history.replaceState(window.history.state, "", "/app/old#section");
  const before = window.history.length;
  const href = window.location.href;
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  spyOn(globalThis, "fetch").mockResolvedValue(response("", { status: 403 }, href));
  await swapPage(href);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(window.location.href).toBe(href);
  expect(window.history.length).toBe(before);
  expect(document.title).toBe("old");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test.each([false, true])("an early 403 for a different hash reloads with replace=%s", async (replaceEntry) => {
  install();
  window.history.replaceState(window.history.state, "", "/app/old#old");
  const before = window.history.length;
  const page = window.history.state[markerKey].page;
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  spyOn(globalThis, "fetch").mockResolvedValue(response("", { status: 403 }, "https://example.test/app/old#new"));
  await swapPage("/app/old#new", { replace: replaceEntry });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe("#new");
  expect(window.history.length).toBe(before + (replaceEntry ? 0 : 1));
  expect(window.history.state[markerKey].page).toBe(page);
  expect(document.title).toBe("old");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a commit failure on a URL with a hash reloads it, since replacing it would only scroll", async () => {
  install();
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new"), {}, "https://example.test/app/requested"));
  spyOn(window, "scrollTo").mockImplementation(() => {
    throw new Error("commit scroll failed");
  });
  const before = window.history.length;
  await swapPage("/app/requested#section");
  expect(reload).toHaveBeenCalledTimes(1);
  expect(window.location.href).toBe("https://example.test/app/requested#section");
  expect(window.history.length).toBe(before + 1);
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a relative <base> that resolves elsewhere on the fetched page loads the document", async () => {
  install();
  const base = document.createElement("base");
  base.setAttribute("href", "assets/");
  document.head.prepend(base);
  // Same attribute on both pages, but the fetched page sits in another directory.
  const next = html("new").replace("<head>", '<head><base href="assets/">');
  spyOn(globalThis, "fetch").mockResolvedValue(response(next, {}, "https://example.test/app/sub/new"));
  await swapPage("/app/sub/new");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith("https://example.test/app/sub/new");
  expect(document.title).toBe("old");
});

test("a same-page hash link stays native and aborts a pending swap", async () => {
  install();
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  expect(click("/app/old#heading").defaultPrevented).toBe(false);
  await pending;
  expect(requests[0]!.aborted).toBe(true);
  expect(document.title).toBe("old");
  expect(assign).not.toHaveBeenCalled();
});

test.each(["native", "stopped", "prevented"])("a %s hash-link popstate checks the click before stamping", async (kind) => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  await swapPage("/app/new");
  const current = window.history.state[markerKey];
  const requests = deferredFetch();
  const anchor = document.createElement("a");
  anchor.href = "#later";
  anchor.addEventListener("click", (event) => {
    if (kind === "stopped") event.stopPropagation();
    if (kind === "prevented") event.preventDefault();
  });
  document.body.append(anchor);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  // Happy DOM needs native fragment history and its null-state popstate emulated.
  arrive(null, "/app/new#later");
  expect(requests).toHaveLength(kind === "prevented" ? 1 : 0);
  expect(window.history.state).toEqual(
    kind === "prevented" ? null : { [markerKey]: { page: current.page, position: current.position + 1 } },
  );
});

test("a deferred navigate() commit that a newer swap overtook does not push its URL", async () => {
  install();
  const pending: (() => void | Promise<void>)[] = [];
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (callback: () => void | Promise<void>) => pending.push(callback),
  });
  try {
    navigate("/app/old?tab=2");
    spyOn(globalThis, "fetch").mockResolvedValue(response());
    await swapPage("/app/new");
    expect(pending).toHaveLength(1);
    await pending[0]!();
    expect(window.location.pathname).toBe("/app/new");
    expect(window.location.search).toBe("");
    expect(window.history.state["@k2b/ssr/nav"].page).toMatch(/:2$/);
    // A navigate() from the new page still commits after its own deferral.
    navigate("/app/new?tab=3");
    await pending[1]!();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/app/new?tab=3");
  } finally {
    Reflect.deleteProperty(document, "startViewTransition");
  }
});

test("an async Link handler that a newer swap overtook neither moves history nor loads a document", async () => {
  install();
  const linkRoot = document.createElement("div");
  document.querySelector("nav")!.append(linkRoot);
  const steps = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let calls = 0;
  const dispose = render(
    () =>
      Link({
        href: "/app/old?tab=2",
        onNavigate: async ({ push, replaceWith, fallback }) => {
          const step = steps[calls++]!;
          await step.promise;
          if (calls === 1) push();
          else if (calls === 2) replaceWith();
          else fallback();
          if (calls === 3) throw new Error("late handler failed");
        },
        children: "tab",
      }),
    linkRoot,
  );
  const activate = () =>
    linkRoot.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  try {
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => response(), { preconnect: fetch.preconnect }));
    for (const step of steps) {
      activate();
      await swapPage("/app/new");
      expect(document.title).toBe("new");
      const before = window.history.length;
      step.resolve();
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      expect(`${window.location.pathname}${window.location.search}`).toBe("/app/new");
      expect(window.history.length).toBe(before);
    }
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

test.each([null, undefined, { island: 1 }, Object.assign(Object.create(null), { island: 1 })])(
  "history writes merge plain or empty state without mutating it: %j",
  (value: unknown) => {
    install();
    const initial = window.history.state[markerKey];
    window.history.pushState(value, "", "/app/old?tab=1");
    expect(window.history.state).toEqual({ ...(value ?? {}), [markerKey]: { page: initial.page, position: initial.position + 1 } });
    window.history.replaceState(value, "", "/app/old?tab=2");
    expect(window.history.state[markerKey]).toEqual({ page: initial.page, position: initial.position + 1 });
    if (value && typeof value === "object") expect(Object.hasOwn(value, markerKey)).toBe(false);
  },
);

test.each(
  [
    [],
    "state",
    12,
    false,
    new Map([["island", 1]]),
    new Date("2026-10-20T00:00:00Z"),
    new (class State {
      island = 1;
    })(),
  ].map((value) => [value]),
)("non-plain state passes through without a marker: %j", (value) => {
  // Compare with native storage too: Happy DOM normalizes false to null.
  History.prototype.replaceState.call(window.history, value, "");
  const native = window.history.state;
  install();
  window.history.pushState(value, "", "/app/old?tab=1");
  expect(window.history.state).toEqual(native);
  expect(Object.hasOwn(Object(window.history.state), markerKey)).toBe(false);
  window.history.replaceState(value, "", "/app/old?tab=2");
  expect(window.history.state).toEqual(native);
});

test("push overwrites a copied or caller-provided marker; replace preserves the entry's marker and scroll", () => {
  const existing = { page: "existing", position: 17, scroll: { window: { x: 0, y: 22 }, regions: [] } };
  window.history.replaceState({ [markerKey]: existing, island: 1 }, "");
  install();
  const value = { island: 2, [markerKey]: { page: "fake", position: 99 } };
  window.history.replaceState(value, "");
  expect(window.history.state).toEqual({ island: 2, [markerKey]: existing });
  window.history.pushState(value, "");
  expect(window.history.state).toEqual({ island: 2, [markerKey]: { page: "existing", position: 18 } });
  expect(value[markerKey]).toEqual({ page: "fake", position: 99 });
});

test("wrappers are own properties installed once and stay inert after uninstall", () => {
  install();
  const { pushState, replaceState } = window.history;
  expect(Object.hasOwn(window.history, "pushState")).toBe(true);
  expect(Object.hasOwn(window.history, "replaceState")).toBe(true);
  installPageSwap();
  expect(window.history.pushState).toBe(pushState);
  uninstall();
  window.history.pushState(null, "", "/app/old?tab=1");
  expect(window.history.state).toBeNull();
  window.history.replaceState({ island: 1 }, "");
  expect(window.history.state).toEqual({ island: 1 });
  install();
  expect(window.history.pushState).toBe(pushState);
  expect(window.history.replaceState).toBe(replaceState);
});

test("scroll restoration is manual for the whole install and restores the previous setting", () => {
  window.history.scrollRestoration = "auto";
  install();
  expect(String(window.history.scrollRestoration)).toBe("manual");
  uninstall();
  expect(String(window.history.scrollRestoration)).toBe("auto");
  window.history.scrollRestoration = "manual";
  install();
  uninstall();
  expect(String(window.history.scrollRestoration)).toBe("manual");
  window.history.scrollRestoration = "auto";
});

test("listenPopState installed before nav handles same-page entries and hides cross-page entries", async () => {
  const handler = mock(() => {});
  const stop = listenPopState(handler);
  try {
    install();
    const entry = window.history.state;
    window.dispatchEvent(new PopStateEvent("popstate", { state: entry }));
    expect(handler).toHaveBeenCalledTimes(1);
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response());
    const done = swapped("new");
    arrive({ [markerKey]: { page: "other", position: 12 } }, "/app/new");
    await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

test("persisted pageshow on a foreign entry starts a traversal swap", async () => {
  install();
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response());
  History.prototype.replaceState.call(window.history, { [markerKey]: { page: "cached", position: 3 } }, "", "/app/new");
  const done = swapped("new");
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  window.dispatchEvent(event);
  await done;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(window.history.state[markerKey]).toEqual({ page: "cached", position: 3 });
});

test("an unpatched unmarked push swaps on popstate and gains a new page id", async () => {
  install();
  const before = window.history.state[markerKey].page;
  History.prototype.pushState.call(window.history, null, "", "/app/new");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response());
  const done = swapped("new");
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  await done;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(window.history.state[markerKey].page).not.toBe(before);
});

test.each([
  "old-string",
  { page: "", position: 1 },
  { page: "other", position: "1" },
  { page: "other", position: NaN },
  { page: "other", position: 1, scroll: { window: { x: 0, y: 0 }, regions: [{}] } },
])("invalid marker fails safe on traversal: %j", async (invalid) => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  const done = swapped("new");
  arrive({ [markerKey]: invalid }, "/app/new");
  await done;
  expect(window.history.state[markerKey]).toEqual({ page: expect.any(String), position: expect.any(Number) });
});

test.each(["push", "replace to another URL"])("an island %s during a traversal fetch drops it without reload", async (mode) => {
  install();
  const requests = deferredFetch(true);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  arrive({ [markerKey]: { page: "other", position: 5 } }, "/app/new");
  if (mode === "push") window.history.pushState(null, "", "/app/new");
  else window.history.replaceState({}, "", "/app/new?moved");
  const result = response();
  const read = spyOn(result, "text");
  requests[0]!.resolve(result);
  // The fetch continuation is queued before this continuation.
  await Promise.resolve();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  expect(document.title).toBe("old");
  expect(reload).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

test("an island replace that keeps the arriving URL still lets the traversal commit", async () => {
  install();
  const requests = deferredFetch(true);
  const done = swapped("new");
  arrive({ [markerKey]: { page: "other", position: 5 } }, "/app/new");
  window.history.replaceState({ island: 1 }, "", "/app/new");
  requests[0]!.resolve(response());
  await done;
  expect(window.history.state).toEqual({ island: 1, [markerKey]: { page: "other", position: 5 } });
});

test("a traversal redirect inside scope reloads the arriving URL without changing history", async () => {
  install();
  const done = Promise.withResolvers<void>();
  const reload = spyOn(window.location, "reload").mockImplementation(() => done.resolve());
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("redirected"), {}, "https://example.test/app/redirected"));
  const before = window.history.length;
  arrive({ [markerKey]: { page: "other", position: 5 } }, "/app/new#section");
  await done.promise;
  expect(reload).toHaveBeenCalledTimes(1);
  expect(window.history.length).toBe(before);
  expect(window.location.href).toBe("https://example.test/app/new#section");
  expect(document.title).toBe("old");
});

test("pagehide persists scroll; reload restores window and keyed regions", () => {
  const snapshot = { window: { x: 0, y: 220 }, regions: [{ key: "list", x: 0, y: 80 }] };
  document.querySelector("main")!.insertAdjacentHTML("beforeend", '<div data-scroll-preserve="list"></div>');
  const region = document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!;
  region.scrollTop = 80;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => 220 });
  install();
  window.dispatchEvent(new Event("pagehide"));
  expect(window.history.state[markerKey].scroll).toEqual(snapshot);
  const page = window.history.state[markerKey].page;
  uninstall();
  region.scrollTop = 0;
  const timing = { name: window.location.href, entryType: "navigation", startTime: 0, duration: 0, type: "reload", toJSON: () => ({}) };
  spyOn(window.performance, "getEntriesByType").mockReturnValue([timing]);
  install();
  expect(window.history.state[markerKey].page).toBe(page);
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 220);
  expect(region.scrollTop).toBe(80);
});

test.each(["swap", "push", "pagehide", "traversal"])("%s saves the shown entry after a dialog-only Back hidden from nav", async (mode) => {
  const navigation = Object.assign(new EventTarget(), { currentEntry: { key: "page", index: 0 } });
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
  let y = 120;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  try {
    install();
    const page = window.history.state;
    window.history.pushState({ dialog: true }, "");
    navigation.currentEntry = { key: "dialog", index: 1 };
    navigation.dispatchEvent(
      Object.assign(new Event("navigate"), { navigationType: "traverse", destination: { key: "page" }, hashChange: false }),
    );
    // dialog-core consumes this popstate before nav; the Navigation API still reports its departure.
    History.prototype.replaceState.call(window.history, page, "");
    navigation.currentEntry = { key: "page", index: 0 };
    y = 460;
    if (mode === "pagehide") {
      window.dispatchEvent(new Event("pagehide"));
      expect(window.history.state[markerKey].scroll?.window.y).toBe(460);
      return;
    }
    if (mode === "push") window.history.pushState(null, "", "/app/old?tab=1");
    else {
      spyOn(globalThis, "fetch").mockResolvedValue(response());
      if (mode === "swap") await swapPage("/app/new");
      else {
        navigation.dispatchEvent(
          Object.assign(new Event("navigate"), { navigationType: "traverse", destination: { key: "other" }, hashChange: false }),
        );
        navigation.currentEntry = { key: "other", index: 1 };
        const done = swapped("new");
        arrive({ [markerKey]: { page: "other", position: 1 } }, "/app/new");
        await done;
      }
      spyOn(globalThis, "fetch").mockResolvedValue(response(html("old"), {}, "https://example.test/app/old"));
    }
    y = 0;
    const done = mode === "push" ? Promise.resolve() : swapped("old");
    arrive(page);
    await done;
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 460);
  } finally {
    uninstall();
    Reflect.deleteProperty(window, "navigation");
  }
});

test("departure snapshots survive pagehide and a reload before Forward", async () => {
  document.querySelector("main")!.insertAdjacentHTML("beforeend", '<div data-scroll-preserve="list"></div>');
  document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!.scrollTop = 60;
  let y = 130;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  install();
  const a = window.history.state;
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", scrollId))));
  await swapPage("/app/new");
  const b = {
    ...window.history.state,
    [markerKey]: { ...window.history.state[markerKey], scroll: { window: { x: 0, y: 20 }, regions: [{ key: "list", x: 0, y: 10 }] } },
  };
  y = 690;
  document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!.scrollTop = 90;
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("old", wrapper("old", scrollId)), {}, "https://example.test/app/old"));
  const back = swapped("old");
  arrive(a);
  await back;
  y = 130;
  window.dispatchEvent(new Event("pagehide"));
  uninstall();
  y = 0;
  document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!.scrollTop = 0;
  const timing = { name: window.location.href, entryType: "navigation", startTime: 0, duration: 0, type: "reload", toJSON: () => ({}) };
  spyOn(window.performance, "getEntriesByType").mockReturnValue([timing]);
  install();
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 130);
  expect(document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!.scrollTop).toBe(60);
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", scrollId))));
  const forward = swapped("new");
  arrive(b, "/app/new");
  await forward;
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 690);
  expect(document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!.scrollTop).toBe(90);
});

test.each(["{", "null", "{}", '[null, [12, {}], ["bad", {}], ["bad-window", {"window":{"x":0,"y":"12"},"regions":[]}]]'])(
  "malformed stored scroll is ignored: %s",
  (stored) => {
    window.sessionStorage.setItem(scrollKey, stored);
    install();
    const entry = window.history.state[markerKey];
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(window.sessionStorage.getItem(scrollKey)!)).toEqual([
      [`${entry.page}:${entry.position}`, { window: { x: 0, y: 0 }, regions: [] }],
    ]);
  },
);

test.each(["getItem", "setItem"] as const)("unavailable storage (%s) does not break navigation", async (method) => {
  spyOn(window.sessionStorage, method).mockImplementation(() => {
    throw new DOMException("Storage unavailable", "SecurityError");
  });
  install();
  window.dispatchEvent(new Event("pagehide"));
  expect(window.history.state[markerKey].scroll).toEqual({ window: { x: 0, y: 0 }, regions: [] });
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  await swapPage("/app/new");
  expect(document.title).toBe("new");
});

test("the scroll map keeps the 50 most recently remembered entries, including after loading", () => {
  const snapshot = { window: { x: 0, y: 15 }, regions: [] };
  window.sessionStorage.setItem(scrollKey, JSON.stringify(Array.from({ length: 55 }, (_, index) => [`stored:${index}`, snapshot])));
  install();
  const initial = window.history.state;
  const entry = initial[markerKey];
  window.dispatchEvent(new Event("pagehide"));
  let stored = JSON.parse(window.sessionStorage.getItem(scrollKey)!);
  expect(stored).toHaveLength(50);
  expect(stored[0][0]).toBe("stored:6");
  for (let index = 0; index < 49; index++) window.history.pushState(null, "", `/app/old?tab=${index}`);
  // Revisiting an entry refreshes its recency rather than evicting it on the next push.
  arrive(initial);
  window.history.pushState(null, "", "/app/old?last");
  window.dispatchEvent(new Event("pagehide"));
  stored = JSON.parse(window.sessionStorage.getItem(scrollKey)!);
  expect(stored).toHaveLength(50);
  expect(stored.some(([key]: [string, unknown]) => key.startsWith("stored:"))).toBe(false);
  expect(stored.at(-2)[0]).toBe(`${entry.page}:${entry.position}`);
});

test("overlapping Back traversals keep A1's scroll for Forward", async () => {
  install();
  const a0 = window.history.state;
  window.history.pushState(null, "", "/app/old?tab=1");
  let y = 400;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  const a1 = window.history.state;
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("B"), {}, "https://example.test/app/B"));
  await swapPage("/app/B");
  y = 900;
  const requests = deferredFetch(true);
  arrive(a1, "/app/old?tab=1");
  arrive(a0);
  expect(requests[0]!.aborted).toBe(true);
  const done = swapped("old");
  requests[1]!.resolve(response(html("old"), {}, "https://example.test/app/old"));
  await done;
  requests[0]!.resolve(response(html("old"), {}, "https://example.test/app/old?tab=1"));
  await Promise.resolve();
  y = 0;
  arrive(a1, "/app/old?tab=1");
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 400);
  expect(document.title).toBe("old");
  expect(requests).toHaveLength(2);
});

test("a fragment navigation during a pending traversal belongs to the arriving page and swaps it", async () => {
  const navigation = Object.assign(new EventTarget(), { currentEntry: { key: "initial", index: 3 } });
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
  try {
    install();
    const requests = deferredFetch(true);
    navigation.dispatchEvent(
      Object.assign(new Event("navigate"), { navigationType: "traverse", destination: { key: "arrival" }, hashChange: false }),
    );
    navigation.currentEntry = { key: "arrival", index: 1 };
    arrive({ [markerKey]: { page: "other", position: 1 } }, "/app/new");
    // The hash link in the still-shown old column aborts the pending fetch before its fragment navigation.
    // Happy DOM's own fragment navigation is replaced by the explicit navigate, push, and popstate below.
    const native = (event: Event) => event.preventDefault();
    window.addEventListener("click", native);
    click("/app/new#section");
    window.removeEventListener("click", native);
    expect(requests[0]!.aborted).toBe(true);
    await Promise.resolve();
    navigation.dispatchEvent(
      Object.assign(new Event("navigate"), { navigationType: "push", destination: { key: "fragment" }, hashChange: true }),
    );
    navigation.currentEntry = { key: "fragment", index: 2 };
    History.prototype.pushState.call(window.history, null, "", "/app/new#section");
    const listener = mock();
    const stop = listenPopState(listener);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    stop();
    expect(requests[0]!.aborted).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(window.history.state[markerKey]).toEqual({ page: "other", position: 2 });
    const done = swapped("new");
    requests[1]!.resolve(response());
    await done;
    expect(window.location.hash).toBe("#section");
    expect(window.history.state[markerKey]).toEqual({ page: "other", position: 2 });
  } finally {
    uninstall();
    Reflect.deleteProperty(window, "navigation");
  }
});

test("a hash navigation after a dialog Back that nav never saw departs from the page entry", () => {
  const navigation = Object.assign(new EventTarget(), { currentEntry: { key: "page", index: 4 } });
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
  const navigate = (navigationType: string, key: string, hashChange: boolean) =>
    navigation.dispatchEvent(Object.assign(new Event("navigate"), { navigationType, destination: { key }, hashChange }));
  try {
    install();
    const page = window.history.state;
    let y = 120;
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
    window.history.pushState({ ...window.history.state, k2bDialog: 1 }, "");
    navigation.currentEntry = { key: "dialog", index: 5 };
    // dialog-core stops this Back before nav sees its popstate.
    navigate("traverse", "page", false);
    navigation.currentEntry = { key: "page", index: 4 };
    History.prototype.replaceState.call(window.history, page, "", "/app/old");
    y = 650;
    navigate("push", "", true);
    navigation.currentEntry = { key: "hash", index: 5 };
    History.prototype.pushState.call(window.history, null, "", "/app/old#later");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(window.history.state[markerKey]).toEqual({ page: page[markerKey].page, position: page[markerKey].position + 1 });
    y = 0;
    navigate("traverse", "page", false);
    navigation.currentEntry = { key: "page", index: 4 };
    arrive(page);
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 650);
  } finally {
    uninstall();
    Reflect.deleteProperty(window, "navigation");
  }
});

test("scrolling the shown page while a traversal loads keeps that scroll for Forward", async () => {
  install();
  let y = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  const a = window.history.state;
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("B"), {}, "https://example.test/app/B"));
  await swapPage("/app/B");
  const b = window.history.state;
  y = 500;
  const requests = deferredFetch(true);
  arrive(a);
  y = 800;
  const back = swapped("old");
  requests[0]!.resolve(response(html("old"), {}, "https://example.test/app/old"));
  await back;
  y = 0;
  const forward = swapped("B");
  arrive(b, "/app/B");
  requests[1]!.resolve(response(html("B"), {}, "https://example.test/app/B"));
  await forward;
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 800);
});

test("a bfcache return to an earlier same-page entry keeps that entry's own scroll", () => {
  install();
  const a0 = window.history.state;
  let y = 200;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  window.history.pushState(null, "", "/app/old?tab=1");
  y = 700;
  window.dispatchEvent(new Event("pagehide"));
  History.prototype.replaceState.call(window.history, a0, "", "/app/old");
  const show = new Event("pageshow");
  Object.defineProperty(show, "persisted", { value: true });
  window.dispatchEvent(show);
  window.dispatchEvent(new PopStateEvent("popstate", { state: a0 }));
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 200);
});

test("pagehide during traversal leaves the arriving entry's saved scroll intact", async () => {
  install();
  const requests = deferredFetch(true);
  const entry = { page: "other", position: 4, scroll: { window: { x: 0, y: 400 }, regions: [] } };
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => 900 });
  arrive({ [markerKey]: entry }, "/app/new");
  window.dispatchEvent(new Event("pagehide"));
  const saved = window.history.state[markerKey];
  const done = swapped("new");
  requests[0]!.resolve(response());
  await done;
  expect(saved).toEqual(entry);
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 400);
});

test.each(["reload", "back_forward"])("%s restores saved region scroll again after all initial islands mount", async (type) => {
  disposeIslands(document);
  document.querySelector("main")!.insertAdjacentHTML("beforeend", wrapper("list", scrollId));
  const snapshot = { window: { x: 0, y: 240 }, regions: [{ key: "list", x: 0, y: 110 }] };
  window.history.replaceState({ [markerKey]: { page: "reloaded", position: 4, scroll: snapshot } }, "");
  const timing = { name: window.location.href, entryType: "navigation", startTime: 0, duration: 0, type, toJSON: () => ({}) };
  spyOn(window.performance, "getEntriesByType").mockReturnValue([timing]);
  install();
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 240);
  mountIslands(document.querySelector("solid-island")!);
  await (window as unknown as Window).happyDOM.waitUntilComplete();
  expect(window.scrollTo).toHaveBeenCalledTimes(1);
  await import(`${prefix}/${scrollId}.js`);
  mountIslands(document);
  await (window as unknown as Window).happyDOM.waitUntilComplete();
  expect(document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')?.scrollTop).toBe(110);
  expect(window.scrollTo).toHaveBeenCalledTimes(2);
});

test.each(["wheel", "touchstart", "keydown", "pointerdown"])("%s before initial islands mount cancels the reload replay", async (input) => {
  const snapshot = { window: { x: 0, y: 240 }, regions: [{ key: "list", x: 0, y: 110 }] };
  const timing = { name: window.location.href, entryType: "navigation", startTime: 0, duration: 0, type: "reload", toJSON: () => ({}) };
  spyOn(window.performance, "getEntriesByType").mockReturnValue([timing]);
  await import(`${prefix}/${scrollId}.js`);
  // The control proves that cancelling input, rather than a missing replay, preserves the person's scroll.
  for (const cancel of [false, true]) {
    disposeIslands(document);
    document.querySelector("main")!.innerHTML = wrapper("list", scrollId);
    window.history.replaceState({ [markerKey]: { page: "reloaded", position: 4, scroll: snapshot } }, "");
    install();
    if (cancel) window.dispatchEvent(new Event(input));
    mountIslands(document);
    const region = document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!;
    region.scrollTop = 37;
    await (window as unknown as Window).happyDOM.waitUntilComplete();
    expect(region.scrollTop).toBe(cancel ? 37 : 110);
    uninstall();
  }
});

test("Navigation API supplies base and arriving positions and captures the departing entry before popstate", async () => {
  const navigation = Object.assign(new EventTarget(), { currentEntry: { key: "initial", index: 71 } });
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
  try {
    install();
    const initial = window.history.state[markerKey];
    expect(initial.position).toBe(71);
    let y = 310;
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
    navigation.dispatchEvent(
      Object.assign(new Event("navigate"), { navigationType: "traverse", destination: { key: "arrival" }, hashChange: false }),
    );
    navigation.currentEntry = { key: "arrival", index: 65 };
    spyOn(globalThis, "fetch").mockResolvedValue(response());
    const done = swapped("new");
    arrive(null, "/app/new");
    // The shown page scrolls while the arriving page loads; its last snapshot wins.
    y = 990;
    await done;
    expect(window.history.state[markerKey].position).toBe(65);
    const back = swapped("old");
    spyOn(globalThis, "fetch").mockResolvedValue(response(html("old"), {}, "https://example.test/app/old"));
    arrive({ [markerKey]: initial });
    await back;
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 990);
  } finally {
    uninstall();
    Reflect.deleteProperty(window, "navigation");
  }
});

test("a rejected push keeps the tracked position even when the current state is unmarked", () => {
  install();
  const initial = window.history.state[markerKey];
  window.history.replaceState([], "");
  const length = window.history.length;
  expect(() => window.history.pushState(null, "", "https://other.test/")).toThrow(DOMException);
  expect(window.history.length).toBe(length);
  expect(window.history.state).toEqual([]);
  window.history.pushState(null, "", "/app/old?tab=1");
  expect(window.history.state[markerKey]).toEqual({ page: initial.page, position: initial.position + 1 });
});

test("an old uninstall cannot change scroll restoration after a new install", () => {
  window.history.scrollRestoration = "auto";
  install();
  const oldUninstall = uninstall;
  uninstall();
  install();
  oldUninstall();
  expect(String(window.history.scrollRestoration)).toBe("manual");
  uninstall();
  expect(String(window.history.scrollRestoration)).toBe("auto");
});

test.each(failures)("a traversal's %s failure reloads only the arriving entry", async (_name, make) => {
  install();
  const done = Promise.withResolvers<void>();
  const reload = spyOn(window.location, "reload").mockImplementation(() => done.resolve());
  spyOn(globalThis, "fetch").mockResolvedValue(make());
  const before = window.history.length;
  arrive({ [markerKey]: { page: "other", position: 7 } }, "/app/new");
  await done.promise;
  expect(reload).toHaveBeenCalledTimes(1);
  expect(window.history.length).toBe(before);
  expect(document.title).toBe("old");
  expect(assign).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test("a late failure after marking an unmarked traversal still reloads", async () => {
  install();
  const done = Promise.withResolvers<void>();
  const reload = spyOn(window.location, "reload").mockImplementation(() => done.resolve());
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {
    throw new Error("focus failed");
  });
  arrive(null, "/app/new");
  await done.promise;
  expect(window.history.state[markerKey]).toEqual({ page: expect.any(String), position: expect.any(Number) });
  expect(reload).toHaveBeenCalledTimes(1);
});

test("same-page traversal restores window before the island and leaves region scroll to it", () => {
  const snapshot = { window: { x: 0, y: 130 }, regions: [{ key: "list", x: 0, y: 90 }] };
  window.history.replaceState({ [markerKey]: { page: "same", position: 3, scroll: snapshot } }, "");
  install();
  window.history.pushState(null, "", "/app/old?tab=1");
  document.querySelector("main")!.insertAdjacentHTML("beforeend", '<div data-scroll-preserve="list"></div>');
  const region = document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')!;
  region.scrollTop = 12;
  const stop = listenPopState(() => {
    // The departure map takes precedence over the older persisted snapshot.
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0);
    expect(region.scrollTop).toBe(12);
    window.scrollTo(0, 777);
  });
  try {
    arrive({ [markerKey]: { page: "same", position: 3, scroll: snapshot } });
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 777);
  } finally {
    stop();
  }
});

test("a traversal restores stored window and region scroll after mounting the new island", async () => {
  install();
  const snapshot = { window: { x: 0, y: 240 }, regions: [{ key: "list", x: 0, y: 110 }] };
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", scrollId))));
  const done = swapped("new");
  arrive({ [markerKey]: { page: "other", position: 4, scroll: snapshot } }, "/app/new");
  await done;
  expect(document.querySelector<HTMLElement>('[data-scroll-preserve="list"]')?.scrollTop).toBe(110);
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 240);
});
