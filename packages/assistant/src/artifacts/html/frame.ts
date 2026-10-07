// The prelude: the only hash-pinned script in an app frame. It hardens the
// realm, installs `cloud`, loads the app's modules from blob URLs, relays
// errors, logs, readiness and the URL hash to the host, and turns natural
// browser code that cannot work here into clear errors. Bundled to an IIFE.
import "./no-eval";
import { LIMITS } from "../contracts";
import { createBridge } from "../runtime/bridge";
import { createCloud } from "../runtime/cloud";
import { CloudError } from "../runtime/errors";
import { chartOptions, chartSvg } from "../runtime/lib";
import { ensureRandomUuid } from "../runtime/random-uuid";
import { moduleSpecifiers } from "./imports";
import type { FrameConfig, FrameLogLevel, FrameToHost, HostToFrame } from "./protocol";

for (const key of [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceTransport",
  "RTCSctpTransport",
  "RTCDtlsTransport",
])
  try {
    delete (self as unknown as Record<string, unknown>)[key];
  } catch {}
ensureRandomUuid();

const configElement = document.getElementById("cloud-config")!;
const config = JSON.parse(configElement.textContent!) as FrameConfig;
configElement.remove();
/** The Cloud page that mounted this app; the wrapper between them has no script. */
const host = parent.parent;
const send = (message: FrameToHost) => host.postMessage(message, "*");
const nativeFetch = fetch.bind(self);

// ---------------------------------------------------------------- errors and logs

const fileOf = new Map<string, string>();
const named = (text: string) => {
  for (const [url, path] of fileOf) text = text.replaceAll(url, path);
  return text;
};
const show = (value: unknown): string => {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error)
      return value.stack?.includes(value.message) ? value.stack : `${value.name}: ${value.message}\n${value.stack ?? ""}`;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
const clip = (text: string) => named(text).slice(0, 2000);

/** At most `LIMITS.logs` diagnostics per second; the rest are dropped, so a chatty or failing app never uses up the message budget of its mount. */
const budget = () => {
  let start = 0;
  let count = 0;
  return () => {
    const now = performance.now();
    if (now - start >= 1000) {
      start = now;
      count = 0;
    }
    return ++count <= LIMITS.logs;
  };
};
// Errors have their own budget, so chatty logs never hide them.
const logs = budget();
const errors = budget();
for (const level of ["log", "info", "warn", "error"] as const satisfies FrameLogLevel[]) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    if ((level === "error" ? errors : logs)()) send({ type: "log", level, text: clip(args.map(show).join(" ")) });
  };
}
addEventListener("error", (event: ErrorEvent) => {
  if (!errors()) return;
  const where = event.filename ? `${named(event.filename)}:${event.lineno}:${event.colno}` : undefined;
  send({ type: "error", text: clip(event.error instanceof Error ? show(event.error) : String(event.message)), where });
});
addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  if (!errors()) return;
  const reason = event.reason as { name?: string; code?: string } | undefined;
  send({ type: "error", text: clip(`Unhandled rejection: ${show(event.reason)}`) });
  // A failed cloud.* call nobody handled must not leave a silently dead button. Cloud words the notice from the code.
  if (reason?.name === "CloudError") send({ type: "notice", code: String(reason.code) });
});
// One report per directive and blocked origin: a list of 800 external images is one finding, not 1,600 messages.
const blocked = new Set<string>();
document.addEventListener("securitypolicyviolation", (event) => {
  const inline = event.effectiveDirective === "script-src-attr" || (event.effectiveDirective === "script-src-elem" && !event.blockedURI);
  let source = event.blockedURI;
  try {
    source = new URL(source).origin;
  } catch {}
  const key = inline ? "inline" : `${event.effectiveDirective}${source ? ` ${source}` : ""}`;
  if (blocked.has(key) || !errors()) return;
  blocked.add(key);
  send({
    type: "log",
    level: "error",
    text: `Blocked by the app sandbox: ${inline ? "an inline handler or script (use addEventListener in app.js)" : key}`,
  });
});

// ---------------------------------------------------------------- bridge and cloud

// The bridge only sends rpc and cancel messages, both part of FrameToHost.
const bridge = createBridge((message) => send(message as FrameToHost));
let inflight = 0;
let lastSettled = performance.now();
const thenable = (value: unknown, depth = 0): boolean =>
  !!value &&
  typeof value === "object" &&
  (typeof (value as { then?: unknown }).then === "function" ||
    (depth < 2 &&
      !(value instanceof Blob) &&
      !ArrayBuffer.isView(value) &&
      Object.values(value).some((item) => thenable(item, depth + 1))));
/** Every cloud.* call goes through here, so `ready` and settling know what is still pending. */
const rpc = (method: string, args: unknown[] = [], signal?: AbortSignal) => {
  if (args.some((arg) => thenable(arg)))
    return Promise.reject(new CloudError("invalid", "An argument is a Promise; await it before passing it to cloud."));
  inflight++;
  return bridge.rpc(method, args, signal).finally(() => {
    if (!--inflight) lastSettled = performance.now();
  });
};
addEventListener("message", (event: MessageEvent) => {
  if (event.source !== host) return;
  const message = event.data as HostToFrame;
  if (message?.type === "result") bridge.result(message);
  else if (message?.type === "theme") document.documentElement.dataset.theme = message.value === "dark" ? "dark" : "light";
  else if (message?.type === "hash" && typeof message.value === "string" && location.hash !== message.value) location.hash = message.value;
  else if (message?.type === "snapshot") send({ type: "snapshot", id: message.id, html: shown() });
});
/** The document as the person sees it: outerHTML keeps attributes only, so current form values move into attributes of a copy. */
function shown() {
  const copy = document.documentElement.cloneNode(true) as HTMLElement;
  const copies = copy.querySelectorAll("input, textarea, select");
  document.querySelectorAll("input, textarea, select").forEach((element, index) => {
    const target = copies[index];
    if (element instanceof HTMLInputElement && target instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") target.toggleAttribute("checked", element.checked);
      else if (element.type !== "password" && element.type !== "file") target.setAttribute("value", element.value);
    } else if (element instanceof HTMLTextAreaElement && target) target.textContent = element.value;
    else if (element instanceof HTMLSelectElement && target instanceof HTMLSelectElement)
      for (const [position, option] of [...element.options].entries())
        target.options[position]?.toggleAttribute("selected", option.selected);
  });
  return `<!doctype html>${copy.outerHTML}`;
}
const cloud = createCloud(rpc, config.context);
Object.defineProperty(self, "cloud", { value: cloud, enumerable: true });

/** Resolves when no cloud.* call has been pending for `quietMs`, at the latest after `maxMs`. */
function settled(quietMs: number, maxMs: number) {
  const until = performance.now() + maxMs;
  return new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      if (now > until || (!inflight && now - lastSettled >= quietMs)) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

// ---------------------------------------------------------------- friendly sandbox

const refuse = (name: string, hint: string) => () => {
  throw new CloudError("unavailable", `${name} does not work in Studio apps: ${hint}`);
};
Object.assign(self, {
  alert: refuse("alert()", "show the message in the page or in a <dialog>"),
  confirm: refuse("confirm()", "ask with a <dialog>"),
  prompt: refuse("prompt()", "ask with a <dialog> that contains a form"),
  print: refuse("print()", "create a PDF with cloud.pdf.render and hand it out with cloud.download"),
  fetch: refuse("fetch()", "the app has no network; use cloud.http.fetch for public HTTPS APIs"),
  open: (url: unknown) => {
    if (/^https?:\/\//i.test(String(url))) send({ type: "open", url: String(url) });
    else console.warn(`open(${String(url)}) was ignored; only https links open, in a new tab after the user confirms.`);
    return null;
  },
});
for (const name of ["localStorage", "sessionStorage", "indexedDB"])
  try {
    Object.defineProperty(self, name, { get: refuse(name, "use cloud.kv.user (per person) or cloud.kv (shared)"), configurable: true });
  } catch {}

// Forms never navigate in Studio apps; the app handles `submit` itself.
addEventListener(
  "submit",
  (event) => {
    if ((event.target as HTMLFormElement).method !== "dialog") event.preventDefault();
  },
  true,
);
addEventListener(
  "click",
  (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || event.defaultPrevented) return;
    const href = link.getAttribute("href")!;
    if (href.startsWith("#")) return;
    event.preventDefault();
    if (link.hasAttribute("download") && /^(blob|data):/i.test(href)) {
      nativeFetch(href)
        .then((response) => response.blob())
        .then((blob) => cloud.download(link.getAttribute("download") || "download", blob))
        .catch((error) => console.error(error));
    } else if (/^https?:/i.test(link.href)) send({ type: "open", url: link.href });
    else console.warn(`The link to ${href} was ignored; only https links open, in a new tab after the user confirms.`);
  },
  true,
);

// ---------------------------------------------------------------- charts and wide tables

// cloud.chart() returns markup before it has a place in the page. Once it is in the
// document, cartesian charts are redrawn at their measured width, so axis room and
// labels fit phones as well as wide screens. PDFs keep the stretched logical drawing.
const drawn = new WeakMap<Element, number>();
const charts = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const element = entry.target as HTMLElement;
    const options = chartOptions.get(element.dataset.chartId ?? "");
    const width = Math.round(entry.contentRect.width);
    if (!options || width < 120 || Math.abs((drawn.get(element) ?? 0) - width) < 8) continue;
    drawn.set(element, width);
    const height = Number.parseFloat(element.style.getPropertyValue("--k2b-chart-height")) || 280;
    element.style.setProperty("--k2b-chart-width", `${width}px`);
    element.innerHTML = chartSvg(options, config.context.locale, width, height);
  }
});
// A table that scrolls inside its <figure> must be reachable by keyboard; only then does it get a tab stop.
const scrollers = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    // Observed: the scroller and its content, since content growth does not resize the scroller.
    const element = (target.hasAttribute("data-cloud-observed") ? target : target.parentElement) as HTMLElement | null;
    if (!element || (element.dataset.cloudTabindex === undefined && element.hasAttribute("tabindex"))) continue;
    element.dataset.cloudTabindex = "";
    if (element.scrollWidth > element.clientWidth + 1) element.tabIndex = 0;
    else element.removeAttribute("tabindex");
  }
});
new MutationObserver(() => {
  for (const element of document.querySelectorAll(".k2b-chart__svg[data-chart-id]:not([data-cloud-observed])")) {
    element.setAttribute("data-cloud-observed", "");
    charts.observe(element);
  }
  for (const element of document.querySelectorAll("figure:has(> table):not([data-cloud-observed]), .scroll:not([data-cloud-observed])")) {
    element.setAttribute("data-cloud-observed", "");
    scrollers.observe(element);
    scrollers.observe(element.firstElementChild ?? element);
  }
}).observe(document, { childList: true, subtree: true });

// ---------------------------------------------------------------- hash

if (config.hash)
  try {
    history.replaceState(null, "", config.hash);
  } catch {
    location.hash = config.hash; // about:srcdoc in an opaque origin may refuse replaceState
  }
addEventListener("hashchange", () => send({ type: "hash", value: location.hash }));

// ---------------------------------------------------------------- modules and ready

const resolve = (from: string, specifier: string) =>
  decodeURIComponent(new URL(specifier, `https://app.invalid/${from}`).pathname.slice(1));

/** Blob URL of an app module with its relative imports rewritten to blob URLs; errors name app files. */
function urlOf(path: string, trail: string[] = []): string {
  const known = [...fileOf].find(([, file]) => file === path)?.[0];
  if (known) return known;
  if (trail.includes(path)) throw new CloudError("invalid", `Circular import: ${[...trail, path].join(" → ")}`);
  const source = config.modules[path];
  if (source === undefined) throw new CloudError("invalid", `Import of a missing app file: ${path}`);
  // Only real imports: import-like text in comments and strings stays as it is.
  let code = "";
  let at = 0;
  for (const { start, end, value } of moduleSpecifiers(source)) {
    if (!/^\.{1,2}\//.test(value)) continue;
    code += source.slice(at, start) + urlOf(resolve(path, value), [...trail, path]);
    at = end;
  }
  code += source.slice(at);
  const url = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=${path}`], { type: "text/javascript" }));
  fileOf.set(url, path);
  return url;
}

async function start() {
  for (const entry of config.entries) {
    try {
      await import(urlOf(entry));
    } catch (error) {
      send({ type: "error", text: clip(show(error)), where: entry });
    }
  }
  await document.fonts.ready;
  // Ready means: modules evaluated (including top-level await), fonts loaded and no cloud.* call pending.
  await settled(100, Math.max(0, config.readyBudgetMs - performance.now()));
  send({ type: "ready", height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => void start(), { once: true });
else void start();
