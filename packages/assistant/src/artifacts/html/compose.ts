// Composer: turns an app's files into the locked-down app document and the
// static wrapper around it. Runs in the Cloud page (needs DOMParser).
//
//   Cloud page → wrapper iframe (no script; network CSP that its srcdoc child
//   inherits) → app iframe (hash-pinned prelude, app modules as blob URLs).
import type { RuntimeContext } from "../runtime/cloud";
import { moduleSpecifiers } from "./imports";
import type { FrameConfig } from "./protocol";

export type LintIssue = { severity: "error" | "warning"; kind: string; message: string; where?: string };
/** App files by relative path: `index.html`, CSS and JavaScript modules. */
export type AppFiles = Record<string, string>;
export type ComposeOptions = {
  prelude: string;
  /** CSP source of the prelude, `'sha256-…'`. */
  preludeHash: string;
  baseCss: string;
  theme: "light" | "dark";
  context: RuntimeContext;
  title: string;
  hash?: string;
  readyBudgetMs?: number;
};

/** Network rules of both frames. The wrapper carries them too, so a composer or parser slip never opens the network. */
const NETWORK =
  "connect-src blob: data:; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; object-src 'none'; form-action 'none'; base-uri 'none'; manifest-src 'none'; frame-src 'none'";
const SCRIPT_TYPES = new Set(["", "text/javascript", "module"]);

const attr = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const isLocal = (url: string) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url);
const clean = (path: string) => path.replace(/^\.\//, "");
const isModule = (path: string) => path.endsWith(".js") || path.endsWith(".mjs");
const resolve = (from: string, specifier: string) =>
  decodeURIComponent(new URL(specifier, `https://app.invalid/${from}`).pathname.slice(1));

/** Blanks comments (keeping line numbers), so a comment that mentions confirm() is no finding. */
const withoutComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_all, before: string) => before);

/** Static checks that catch the sandbox traps before the app runs. */
export function lintSource(path: string, raw: string, files: AppFiles): LintIssue[] {
  const issues: LintIssue[] = [];
  const source = withoutComments(raw);
  const add = (severity: LintIssue["severity"], kind: string, message: string, pattern: RegExp) => {
    const at = source.search(pattern);
    if (at >= 0) issues.push({ severity, kind, message, where: `${path}:${source.slice(0, at).split("\n").length}` });
  };
  if (path.endsWith(".css")) {
    add(
      "warning",
      "theme",
      "prefers-color-scheme follows the device, not Cloud; use the --k2b-* tokens, which switch with the Cloud theme",
      /prefers-color-scheme/,
    );
    add(
      "error",
      "network",
      "@import and url(http…) load nothing in Studio apps; put the CSS into style.css",
      /@import|url\(\s*["']?(https?:)?\/\//i,
    );
    return issues;
  }
  add(
    "error",
    "inline-handler",
    'Inline on…= handlers in generated markup never run; use addEventListener (event delegation: list.addEventListener("click", (e) => e.target.closest("[data-id]")))',
    /<[a-z][^>]*\son[a-z]+\s*=/i,
  );
  add(
    "error",
    "dialog",
    "alert, confirm and prompt do not work in Studio apps; show the message in the page or ask with a <dialog>",
    /(?<![\w.$])(alert|confirm|prompt)\s*\(/,
  );
  add(
    "error",
    "storage",
    "localStorage, sessionStorage and indexedDB are unavailable; use cloud.kv.user (per person) or cloud.kv (shared)",
    /\b(localStorage|sessionStorage|indexedDB)\b/,
  );
  add(
    "error",
    "network",
    "Studio apps have no network; use cloud.http.fetch for public HTTPS APIs",
    /(?<![\w.$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/,
  );
  add("warning", "worker", "Workers cannot load app files in Studio apps; keep the code in app modules", /\bnew\s+(Shared)?Worker\s*\(/);
  for (const { start, value: specifier } of moduleSpecifiers(raw)) {
    const where = `${path}:${raw.slice(0, start).split("\n").length}`;
    if (!/^\.{1,2}\//.test(specifier))
      issues.push({
        severity: "error",
        kind: "import",
        message: `Only relative imports of app files work ("./util.js"), not "${specifier}" (no npm, no CDN)`,
        where,
      });
    else if (files[resolve(path, specifier)] === undefined)
      issues.push({ severity: "error", kind: "import", message: `Import of a missing app file: ${resolve(path, specifier)}`, where });
  }
  return issues;
}

/** Parses index.html, moves scripts and styles into their final form and collects every static finding. */
function prepare(files: AppFiles) {
  const lint: LintIssue[] = [];
  if (files["index.html"] === undefined) lint.push({ severity: "error", kind: "missing", message: "An app needs index.html" });
  const doc = new DOMParser().parseFromString(files["index.html"] ?? "", "text/html");

  const usedStyles = new Set<string>();
  for (const link of [...doc.querySelectorAll("link")]) {
    const href = clean(link.getAttribute("href") ?? "");
    if (link.rel === "stylesheet" && files[href] !== undefined) {
      const style = doc.createElement("style");
      style.textContent = files[href]!;
      usedStyles.add(href);
      link.replaceWith(style);
      continue;
    }
    if (link.rel !== "icon")
      lint.push({
        severity: "error",
        kind: "network",
        message: `<link href="${href}"> was removed: apps load nothing from the network; use style.css`,
      });
    link.remove();
  }

  const modules: AppFiles = {};
  for (const [path, source] of Object.entries(files)) if (isModule(path)) modules[path] = source;
  const entries: string[] = [];
  let inline = 0;
  for (const script of [...doc.querySelectorAll("script")]) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    const src = script.getAttribute("src");
    if (type === "importmap") {
      lint.push({ severity: "error", kind: "import", message: "Import maps are not supported; import app files with relative paths" });
      script.remove();
    } else if (src !== null) {
      const path = clean(src);
      if (!isLocal(src) || modules[path] === undefined)
        lint.push({
          severity: "error",
          kind: "network",
          message: `<script src="${src}"> was removed: only app files load (no CDNs, no npm)`,
        });
      else if (!entries.includes(path)) entries.push(path);
      script.remove();
    } else if (SCRIPT_TYPES.has(type)) {
      // Inline scripts run as app modules, like app.js; only the prelude is a pinned classic script.
      const path = `inline-${++inline}.js`;
      modules[path] = script.textContent ?? "";
      entries.push(path);
      script.remove();
    }
  }
  const imported = (target: string) =>
    Object.entries(modules).some(([path, code]) =>
      moduleSpecifiers(code).some(({ value }) => /^\.{1,2}\//.test(value) && resolve(path, value) === target),
    );
  if (modules["app.js"] !== undefined && !entries.includes("app.js") && !imported("app.js")) entries.push("app.js");

  for (const element of doc.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      if (/^on/i.test(name)) {
        lint.push({
          severity: "error",
          kind: "inline-handler",
          message: `<${element.localName} ${name}> never runs: use addEventListener in app.js`,
          where: "index.html",
        });
        element.removeAttribute(name);
      }
    }
    for (const name of ["src", "href", "poster", "data", "srcset"]) {
      const value = element.getAttribute(name);
      if (value && element.localName !== "a" && /(^|[\s,])(https?:)?\/\//i.test(value))
        lint.push({
          severity: "error",
          kind: "network",
          message: `<${element.localName} ${name}="${value}"> cannot load: apps have no network (use data: URLs or files from cloud.files)`,
        });
    }
  }
  if (doc.querySelector('input[type="password" i]'))
    lint.push({
      severity: "warning",
      kind: "password",
      message: "Password fields in apps look like phishing; store API keys as app secrets and use cloud.http.secret",
    });
  for (const form of doc.querySelectorAll("form:not([method=dialog])"))
    if (form.querySelectorAll("button:not([type])").length > 1)
      lint.push({
        severity: "warning",
        kind: "button-type",
        message: 'A form has several buttons without a type; every button that does not submit needs type="button"',
        where: "index.html",
      });

  for (const [path, source] of Object.entries(files))
    if (path.endsWith(".css") || isModule(path)) lint.push(...lintSource(path, source, files));
  for (const [path, source] of Object.entries(modules))
    if (path.startsWith("inline-")) lint.push(...lintSource(`index.html (${path})`, source, { ...files, ...modules }));
  return { doc, modules, entries, lint, usedStyles };
}

/** Static findings only, without building a document. */
export const lintApp = (files: AppFiles): LintIssue[] => prepare(files).lint;

export function composeApp(files: AppFiles, options: ComposeOptions) {
  const { doc, modules, entries, lint, usedStyles } = prepare(files);
  const config: FrameConfig = {
    context: options.context,
    hash: options.hash ?? "",
    modules,
    entries,
    readyBudgetMs: options.readyBudgetMs ?? 8000,
  };
  const csp = ["default-src 'none'", `script-src ${options.preludeHash} blob:`, "style-src 'unsafe-inline'", NETWORK].join("; ");
  const head = doc.head;
  const element = (tag: string, attributes: Record<string, string>, text?: string) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // The CSP comes first, before any script or style of the document.
  head.prepend(
    element("meta", { charset: "utf-8" }),
    element("meta", { "http-equiv": "Content-Security-Policy", content: csp }),
    element("meta", { "http-equiv": "x-dns-prefetch-control", content: "off" }),
    element("meta", { name: "viewport", content: "width=device-width,initial-scale=1" }),
    element("style", { id: "cloud-base" }, options.baseCss),
    element("script", { type: "application/json", id: "cloud-config" }, json(config)),
    element("script", { id: "cloud-prelude" }, options.prelude),
  );
  for (const [path, source] of Object.entries(files))
    if (path.endsWith(".css") && !usedStyles.has(path)) {
      const style = doc.createElement("style");
      style.textContent = source;
      head.append(style);
    }
  doc.documentElement.lang ||= options.context.locale;
  doc.documentElement.dataset.theme = options.theme;
  if (!doc.title) doc.title = options.title;

  const inner = `<!doctype html>${doc.documentElement.outerHTML}`;
  const wrapper =
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr(NETWORK)}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%}</style>" +
    `<iframe sandbox="allow-scripts allow-forms" title="${attr(options.title)}" srcdoc="${attr(inner)}"></iframe>`;
  return { wrapper, lint, entries };
}
