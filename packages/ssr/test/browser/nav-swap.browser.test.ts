import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Window } from "happy-dom";
import { toJSON } from "seroval";
import { render } from "solid-js/web";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { disposeIslands } from "../../src/mount";
import { documentNavigate, installPageSwap, Link, navigate, navigateTo, refreshCurrentPath, swapPage } from "../../src/nav";
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
test.each(["https://other.test/app/A", "/appbox", "/app/old#heading"])("does not take %s", (href) => {
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
    expect(window.history.state["@k2b/ssr/nav"]).toMatch(/:1$/);
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

test("popstate preserves island history until a swap, then reloads other pages and aborts pending swaps", async () => {
  install();
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  expect(replace).not.toHaveBeenCalled();
  spyOn(globalThis, "fetch").mockResolvedValue(response());
  await swapPage("/app/new");
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  expect(replace).not.toHaveBeenCalled();
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  await pending;
  expect(requests[0]!.aborted).toBe(true);
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledWith(window.location.href);
  expect(assign).not.toHaveBeenCalled();
});

test("install is idempotent; uninstall removes listeners, live region and pending work", async () => {
  const add = spyOn(window, "addEventListener");
  const remove = spyOn(window, "removeEventListener");
  install();
  expect(installPageSwap()).toBe(uninstall);
  expect(add.mock.calls.filter(([type]) => type === "click" || type === "popstate")).toHaveLength(2);
  expect(document.querySelectorAll("[data-nav-announcer]")).toHaveLength(1);
  const requests = deferredFetch();
  const pending = swapPage("/app/A");
  uninstall();
  await pending;
  expect(requests[0]!.aborted).toBe(true);
  expect(remove.mock.calls.filter(([type]) => type === "click" || type === "popstate")).toHaveLength(2);
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
  const committed = Promise.withResolvers<void>();
  const push = window.history.replaceState.bind(window.history);
  spyOn(window.history, "replaceState").mockImplementation((...args) => {
    push(...args);
    committed.resolve();
  });
  requests[0]!.resolve(response(html("new"), {}, "https://example.test/app/old"));
  await committed.promise;
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

test("root scope, absent prefixes without wrappers, and equivalent stylesheet sets are compatible", async () => {
  install();
  document.querySelector("[data-nav-shell]")!.setAttribute("data-nav-scope", "/");
  document.querySelector("script[data-ssr-assets]")!.remove();
  const next = html("new", "")
    .replace('data-nav-scope="/app"', 'data-nav-scope="/"')
    .replace(/<script.*?<\/script>/, "")
    .replace(
      '<link rel="stylesheet" href="/base.css">',
      '<link rel="stylesheet" href="https://example.test/base.css"><link rel="stylesheet" href="/base.css">',
    );
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

test("a newer swap started during disposal owns the page", async () => {
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
    expect(requests).toHaveLength(2);
    expect(window.location.pathname).toBe("/app/old");
    expect(document.title).toBe("old");
    requests[1]!.resolve(response(html("B"), {}, "https://example.test/app/B"));
    await b;
    expect(window.location.href).toBe("https://example.test/app/B");
    expect(document.title).toBe("B");
    expect(document.querySelector("main b")!.textContent).toBe("B");
    expect(events).toEqual(["cleanup:old", "mount:B"]);
    expect(assign).not.toHaveBeenCalled();
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

test("a late commit failure replaces even when a new island overwrites the history marker", async () => {
  install();
  spyOn(globalThis, "fetch").mockResolvedValue(response(html("new", wrapper("new", historyId))));
  const focus = spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {
    throw new Error("commit focus failed");
  });
  const before = window.history.length;
  await swapPage("/app/requested");
  // Fallback must use the local commit flag: the island has removed the page marker.
  expect(window.history.state).toEqual({ island: 1 });
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
  const push = spyOn(window.history, "pushState");
  spyOn(globalThis, "fetch").mockResolvedValue(response(next));
  await swapPage("https://example.test/app/new");
  // Happy DOM resolves relative history URLs against location instead of <base>; require the browser-safe absolute input.
  expect(push).toHaveBeenCalledWith({ "@k2b/ssr/nav": expect.any(String) }, "", "https://example.test/app/new");
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
