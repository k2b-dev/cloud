import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import { composeApp, lintApp } from "./compose";
import { sanitizeSnapshot } from "./snapshot";

let dom: DomTestHarness;
const globals = globalThis as unknown as { DOMParser?: unknown };
beforeEach(() => {
  dom = createDomTestHarness();
  globals.DOMParser = dom.window.DOMParser;
});
afterEach(() => {
  delete globals.DOMParser;
  dom.cleanup();
});

const options = {
  prelude: "/* prelude */",
  preludeHash: "'sha256-prelude'",
  baseCss: "@layer k2b-base{}",
  theme: "dark" as const,
  context: { locale: "de-DE", timeZone: "Europe/Berlin", user: null },
  title: "Ledger",
};
/** The app document inside the wrapper's srcdoc. */
const inner = (wrapper: string) => {
  const frame = new dom.window.DOMParser().parseFromString(wrapper, "text/html").querySelector("iframe")!;
  return { frame, doc: new dom.window.DOMParser().parseFromString(frame.getAttribute("srcdoc")!, "text/html") };
};

test("the composer loads style.css and app.js, runs inline scripts as modules and pins only the prelude", () => {
  const { wrapper, entries, lint } = composeApp(
    {
      "index.html": `<link rel="stylesheet" href="style.css"><main><h1>Hi</h1></main><script type="module">import "./lib/a.js";</script><script>console.log(1)</script><script type="application/json" id="data">{"a":1}</script>`,
      "style.css": "h1 { color: var(--k2b-action) }",
      "extra.css": "p { margin: 0 }",
      "app.js": 'const tail = "</script><!--";',
      "lib/a.js": "export const a = 1;",
    },
    options,
  );
  expect(lint).toEqual([]);
  expect(entries).toEqual(["inline-1.js", "inline-2.js", "app.js"]);
  const { frame, doc } = inner(wrapper);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(wrapper).toContain("frame-src 'none'");
  expect(new dom.window.DOMParser().parseFromString(wrapper, "text/html").querySelectorAll("script")).toHaveLength(0);
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
  expect(csp).toContain("default-src 'none'; script-src 'sha256-prelude' blob:; style-src 'unsafe-inline'");
  expect(csp).toContain("connect-src blob: data:");
  // The prelude is the only executable script element; app code travels as JSON.
  const scripts = [...doc.querySelectorAll("script")];
  expect(scripts.map((script) => script.id)).toEqual(["cloud-config", "cloud-prelude", "data"]);
  const config = scripts[0]!.textContent!;
  expect(config).not.toContain("</script");
  expect(JSON.parse(config).modules["app.js"]).toBe('const tail = "</script><!--";');
  expect(JSON.parse(config).context).toEqual(options.context);
  // The base stylesheet comes first, so every app stylesheet after it wins.
  const styles = [...doc.querySelectorAll("style")].map((style) => style.textContent);
  expect(styles[0]).toBe("@layer k2b-base{}");
  expect(styles.slice(1).sort()).toEqual(["h1 { color: var(--k2b-action) }", "p { margin: 0 }"]);
  expect(doc.documentElement.getAttribute("lang")).toBe("de-DE");
  expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(doc.title).toBe("Ledger");
});

test("an app.js that another module imports is not loaded twice", () => {
  const { entries } = composeApp(
    { "index.html": '<script type="module" src="./main.js"></script>', "main.js": 'import "./app.js";', "app.js": "" },
    options,
  );
  expect(entries).toEqual(["main.js"]);
});

test("static checks name the traps of the sandbox before an app runs", () => {
  const issues = lintApp({
    "index.html": `<form><button>A</button><button>B</button></form><input type="password"><img src="https://example.com/x.png"><a href="https://example.com">ok</a><button onclick="go()">Go</button><script src="https://cdn.example.com/react.js"></script><script type="importmap">{}</script><link rel="stylesheet" href="https://cdn.example.com/x.css">`,
    "style.css": "@import url(https://fonts.example.com/x.css); @media (prefers-color-scheme: dark) {}",
    "app.js": [
      'import x from "lodash";',
      'import y from "./missing.js";',
      "// alert() in a comment is fine",
      "confirm('Sure?');",
      "localStorage.setItem('a', 'b');",
      "fetch('/api');",
      "new Worker('w.js');",
      'list.innerHTML = `<li onclick="x()">x</li>`;',
    ].join("\n"),
  });
  expect(issues.map((issue) => `${issue.severity} ${issue.kind}${issue.where ? ` ${issue.where}` : ""}`).sort()).toEqual(
    [
      "error network",
      "error import",
      "error network",
      "error inline-handler index.html",
      "error network",
      "warning password",
      "warning button-type index.html",
      "warning theme style.css:1",
      "error network style.css:1",
      "error inline-handler app.js:8",
      "error dialog app.js:4",
      "error storage app.js:5",
      "error network app.js:6",
      "warning worker app.js:7",
      "error import app.js:1",
      "error import app.js:2",
    ].sort(),
  );
  expect(lintApp({ "app.js": "" })).toEqual([{ severity: "error", kind: "missing", message: "An app needs index.html" }]);
});

test("a snapshot keeps the content and styles of an app but runs nothing", () => {
  const html = sanitizeSnapshot(
    `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><script id="cloud-prelude">x()</script><style>p{color:red}</style><base href="https://evil.example/"></head><body><p onclick="steal()">Total 30</p><a href=" javascript:alert(1)">x</a><iframe srcdoc="x"></iframe><img src="data:image/png;base64,AAAA"><a href="data:text/html;base64,PHNjcmlwdD4=">y</a><svg><a href="javascript:x()"><text>t</text></a></svg></body></html>`,
  );
  expect(html).toContain("Total 30");
  expect(html).toContain("p{color:red}");
  expect(html).toContain("data:image/png;base64,AAAA");
  for (const removed of ["<script", "onclick", "javascript:", "refresh", "<iframe", "<base", "data:text/html"])
    expect(html).not.toContain(removed);
  expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"`);
});
