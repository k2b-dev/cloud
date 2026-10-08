import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { browserName, launchBrowser } from "../../../../ui/test/browser";
import { type ArtifactSource, LIMITS } from "../contracts";
import type { AppFrameAssets } from "./assets";
import { buildBaseCss, buildCheckPrelude } from "./build-assets";
import { runHtmlCheck } from "./check";
import { CHECK_LIMITS, type CheckStep, checkHash, readCheckSteps } from "./check-contracts";

let browser: Browser, runtime: string, assets: AppFrameAssets;
const scopes = new Map<string, Map<string, string>>();
let seq = 0;
beforeAll(async () => {
  const [prelude, baseCss, built] = await Promise.all([
    buildCheckPrelude(),
    buildBaseCss(),
    Bun.build({ entrypoints: [new URL("./check-host.ts", import.meta.url).pathname], target: "browser", format: "iife" }),
  ]);
  if (!built.success) throw new AggregateError(built.logs, "check harness build failed");
  runtime = await built.outputs[0]!.text();
  assets = { prelude, preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`, baseCss };
  browser = await launchBrowser(
    browserName === "chromium" ? { args: ["--site-per-process", "--enable-features=IsolateSandboxedIframes:grouping/per-document"] } : {},
  );
}, 120000);
afterAll(async () => {
  await browser?.close();
});
async function check(html: string, js = "", steps: CheckStep[] = [], css = "", artifactId: string | null = "App234") {
  const source: ArtifactSource = {
    entry: "index.html",
    files: [
      { path: "index.html", content: html },
      { path: "app.js", content: js },
      { path: "steps.json", content: JSON.stringify(steps) },
      { path: "style.css", content: css },
    ],
  };
  const saved = new Map<string, Uint8Array>();
  const copies: string[] = [];
  const downloadCalls: number[] = [];
  const report = await runHtmlCheck({
    browser,
    conversationId: "00000000-0000-4000-8000-000000000001",
    signal: new AbortController().signal,
    initialize: async (page) => {
      const view = downloadCalls.push(0) - 1;
      await page.exposeFunction("recordCheckDownload", () => {
        downloadCalls[view] = downloadCalls[view]! + 1;
      });
      // WebKit routes blob module imports too; only HTTP(S) belongs to the mock server.
      await page.route(
        (url) => /^https?:$/.test(url.protocol),
        async (route) => {
          const match = /^\/api\/assistant\/artifacts\/([^/]+)\/storage$/.exec(new URL(route.request().url()).pathname);
          if (match) {
            const scope = scopes.get(match[1]!);
            const input: { scope: string; key: string; operation: string; content?: string } = route.request().postDataJSON();
            if (!scope) return route.fulfill({ status: 404, json: { message: "Scope gone" } });
            const key = input.scope + ":" + input.key;
            if (input.operation === "write") {
              scope.set(key, input.content!);
              return route.fulfill({ json: { version: 1 } });
            }
            if (input.operation === "read") return route.fulfill({ json: { item: scope.has(key) ? { content: scope.get(key) } : null } });
            return route.fulfill({ json: {} });
          }
          return route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><html lang=en><head><title>Check</title></head><body></body></html>",
          });
        },
      );
      await page.goto("http://check.test");
      await page.addScriptTag({ content: runtime });
      await page.addScriptTag({
        content: `const download = window.assistantCheckDownload;
        window.assistantCheckDownload = async (...args) => { await window.recordCheckDownload(); return download(...args); };`,
      });
    },
    start: async () => {
      const scopeId = `Scp${String(++seq).padStart(3, "2")}`;
      copies.push(scopeId);
      scopes.set(scopeId, new Map());
      return {
        scopeId,
        artifactId: artifactId ?? undefined,
        source,
        steps: readCheckSteps(source.files),
        hash: checkHash(source, []),
        warnings: [],
        context: { locale: "en-US", timeZone: "UTC", user: { id: "viewer", name: "Viewer" } },
        theme: "light",
        assets,
      };
    },
    discard: async (id) => {
      scopes.delete(id);
    },
    save: async (name, bytes) => {
      saved.set(name, bytes);
      return `/files/${name}`;
    },
    upload: async () => ({ name: "sample.csv", data: Buffer.from("Amount\n12.5").toString("base64"), type: "text/csv" }),
  });
  expect(browser.contexts()).toHaveLength(0);
  expect(copies).toHaveLength(2);
  expect(copies[0]).not.toBe(copies[1]);
  expect(copies.every((id) => !scopes.has(id))).toBe(true);
  return { report, saved, downloadCalls };
}
const todoHtml =
  "<main><h1>Tasks</h1><form><label for=title>New task</label><input id=title required><button>Add</button></form><ul id=list></ul><p role=status></p></main>";
const todoJs = `const form=document.querySelector('form'), title=document.querySelector('#title'), list=document.querySelector('#list');
let todos=(await cloud.kv.user.get('todos'))??[];
function render(){list.innerHTML=cloud.html\`\${todos.map(todo=>cloud.html\`<li><label><input type=checkbox \${todo.done?'checked':''}> \${todo.title}</label></li>\`)}\`;}
form.addEventListener('submit',async()=>{todos.push({title:title.value,done:false});form.reset();render();await cloud.kv.user.set('todos',todos);});
list.addEventListener('change',async(e)=>{todos[0].done=e.target.checked;await cloud.kv.user.set('todos',todos);});render();`;
test("todo main flow uses real input and persists across reload in both copies", async () => {
  const { report, saved } = await check(todoHtml, todoJs, [
    { action: "fill", target: { label: "New task" }, value: "Send invoice" },
    { action: "press", value: "Enter" },
    { action: "reload" },
    { action: "check", target: { role: "checkbox", name: "Send invoice" } },
  ]);
  expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  expect(report.passed).toBe(true);
  expect(report.aria).toContain('checkbox "Send invoice" [checked=true]');
  // K5: states only where they exist, no container names that repeat their children, no label text twice.
  expect(report.aria).toContain('- textbox "New task"\n');
  expect(report.aria).toContain("- listitem\n");
  expect(report.aria).not.toMatch(/^\s*New task$/m);
  expect(report.screenshots.map((shot) => shot.view)).toEqual(["desktop-start", "desktop", "mobile"]);
  expect(saved.size).toBe(3);
}, 60000);
test("runtime errors, failed steps and ambiguous accessible names fail checks", async () => {
  const broken = await check("<main><h1>Broken</h1></main>", 'throw new Error("broken runtime");');
  expect(broken.report.passed).toBe(false);
  expect(broken.report.issues.some((issue) => issue.message.includes("broken runtime"))).toBe(true);
  const missing = await check("<main><h1>Missing</h1><button type=button>Save</button></main>", "", [
    { action: "click", target: { role: "button", name: "Absent" } },
  ]);
  expect(missing.report.issues.some((issue) => issue.kind === "step" && issue.message.includes('"Save"'))).toBe(true);
  const ambiguous = await check("<main><h1>Ambiguous</h1><button type=button>Save</button><button type=button>Save</button></main>", "", [
    { action: "click", target: { role: "button", name: "Save" } },
  ]);
  expect(ambiguous.report.issues.find((issue) => issue.kind === "step")?.message).toBe(
    'Step 1 (click): Ambiguous target "Save". Candidates: 1: "Save", 2: "Save"',
  );
}, 90000);
test("phone horizontal overflow and a clipped control are errors", async () => {
  const { report } = await check(
    "<main><h1>Layout</h1><div id=wide>Wide</div><div class=scroll><div class=inner><button id=save type=button>Save</button></div></div></main>",
    "",
    [{ action: "reload" }],
    "#wide{width:700px}.scroll{width:250px;overflow-x:auto}.inner{width:700px;text-align:right}",
  );
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: "overflow", severity: "error", view: "mobile", message: expect.stringContaining("div#wide") }),
  );
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: "clipped", severity: "error", view: "mobile", message: expect.stringContaining('button#save "Save"') }),
  );
}, 60000);
test("invalid fields warn and buttons without main-flow steps fail", async () => {
  const invalid = await check("<main><h1>Form</h1><form><label>Required<input required></label><button>Submit</button></form></main>", "", [
    { action: "click", target: { role: "button", name: "Submit" } },
  ]);
  expect(invalid.report.issues.some((issue) => issue.kind === "user-invalid" && issue.severity === "warning")).toBe(true);
  const absent = await check("<main><h1>No steps</h1><button type=button>Save</button></main>");
  expect(absent.report.issues.some((issue) => issue.kind === "steps" && issue.severity === "error")).toBe(true);
}, 60000);
test("cloud.download and anchor downloads are captured with readable paths", async () => {
  const { report, saved } = await check(
    '<main><h1>Download</h1><button type=button>Export</button><a id=link download="link.csv">Link</a></main>',
    `document.querySelector('button').addEventListener('click',()=>cloud.download('export.csv','a,b'));document.querySelector('#link').href=URL.createObjectURL(new Blob(['c,d'],{type:'text/csv'}));`,
    [
      { action: "click", target: { role: "button", name: "Export" } },
      { action: "click", target: { role: "link", name: "Link" } },
    ],
  );
  expect(report.downloads).toHaveLength(4);
  expect(report.downloads.every((file) => file.path.startsWith("/files/"))).toBe(true);
  expect([...saved.keys()].some((name) => name.endsWith("export.csv"))).toBe(true);
}, 60000);
test("closed details and placeholders do not enter accessible names; reports include states and status", async () => {
  const { report } = await check(
    '<main><h1>Names</h1><label>Name<input placeholder="Hint"></label><button type=button aria-pressed=true>Filter</button><details><summary>More</summary><p>Hidden instruction</p></details><p role=status>Saved</p></main>',
    "",
    [{ action: "fill", target: { label: "Name" }, value: "Ada" }],
  );
  expect(report.aria).toContain('textbox "Name"');
  expect(report.aria).not.toContain("Hint");
  expect(report.aria).not.toContain("Hidden instruction");
  expect(report.aria).toContain("pressed=true");
  expect(report.aria).toContain("Saved");
}, 60000);

test("cancellation closes pages and discards the scope even during initialization", async () => {
  const abort = new AbortController();
  const discarded: string[] = [];
  const source: ArtifactSource = { entry: "index.html", files: [{ path: "index.html", content: "<h1>Cancel</h1>" }] };
  await expect(
    runHtmlCheck({
      browser,
      conversationId: "00000000-0000-4000-8000-000000000001",
      signal: abort.signal,
      start: async () => ({
        scopeId: "Scp234",
        source,
        steps: [],
        hash: checkHash(source, []),
        warnings: [],
        context: { locale: "en-US", timeZone: "UTC", user: null },
        theme: "light",
        assets,
      }),
      initialize: async () => {
        abort.abort(new Error("Check cancelled"));
      },
      discard: async (id) => {
        discarded.push(id);
      },
      save: async () => {
        throw new Error("Unexpected save");
      },
      upload: async () => {
        throw new Error("Unexpected upload");
      },
    }),
  ).rejects.toThrow("Check cancelled");
  expect(discarded).toEqual(["Scp234"]);
  expect(browser.contexts()).toHaveLength(0);
}, 60000);

test.each(["startup", "step"])(
  "cancellation during %s storage rejects its reason without further saves",
  async (at) => {
    const abort = new AbortController();
    const reason = new Error("Check stopped");
    const discarded: string[] = [],
      saved: string[] = [];
    const source: ArtifactSource = {
      entry: "index.html",
      files: [
        { path: "index.html", content: "<main><h1>Cancel</h1><button type=button>Wait</button></main>" },
        {
          path: "app.js",
          content:
            at === "startup"
              ? 'await cloud.kv.get("wait");'
              : 'document.querySelector("button").addEventListener("click", async () => { await cloud.kv.get("wait"); });',
        },
      ],
    };
    await expect(
      runHtmlCheck({
        browser,
        conversationId: "00000000-0000-4000-8000-000000000001",
        signal: abort.signal,
        start: async () => ({
          scopeId: "Scp234",
          artifactId: "App234",
          source,
          steps: at === "step" ? [{ action: "click", target: { role: "button", name: "Wait" } }] : [],
          hash: checkHash(source, []),
          warnings: [],
          context: { locale: "en-US", timeZone: "UTC", user: null },
          theme: "light",
          assets,
        }),
        initialize: async (page) => {
          await page.route(
            (url) => /^https?:$/.test(url.protocol),
            async (route) => {
              if (new URL(route.request().url()).pathname.endsWith("/storage")) {
                abort.abort(reason);
                await route.abort().catch(() => {});
                return;
              }
              await route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><html lang=en><title>Cancel</title><body></body></html>",
              });
            },
          );
          await page.goto("http://check.test");
          await page.addScriptTag({ content: runtime });
        },
        discard: async (id) => {
          discarded.push(id);
        },
        save: async (name) => {
          saved.push(name);
          return `/files/${name}`;
        },
        upload: async () => {
          throw new Error("Unexpected upload");
        },
      }),
    ).rejects.toBe(reason);
    expect(saved).toEqual(at === "startup" ? [] : ["desktop-start-light.png"]);
    expect(discarded).toEqual(["Scp234"]);
    expect(browser.contexts()).toHaveLength(0);
  },
  60000,
);

test("one-off apps cannot use saved-app storage", async () => {
  const { report } = await check("<main><h1>Todos</h1></main>", "const todos = await cloud.kv.user.get('todos') ?? [];", [], "", null);
  expect(report.passed).toBe(false);
  expect(report.issues.some((issue) => issue.severity === "error" && /Storage requires a saved app/.test(issue.message))).toBe(true);
}, 60000);

test("uncaught error floods resolve within the diagnostic budget", async () => {
  const { report } = await check("<main><h1>Ticks</h1></main>", "setInterval(() => { throw new Error('tick ' + Math.random()); }, 1);");
  expect(report.passed).toBe(false);
  expect(report.issues.length).toBeLessThanOrEqual(CHECK_LIMITS.issues);
}, 60000);

test("uncaught unavailable HTTP rejections only warn without duplicate host errors", async () => {
  const { report } = await check(
    "<main><h1>Load data</h1><button type=button>Load</button></main>",
    "document.querySelector('button').addEventListener('click', () => { cloud.http.fetch('https://example.com'); });",
    [{ action: "click", target: { role: "button", name: "Load" } }],
  );
  expect(report.issues.some((issue) => issue.kind === "host")).toBe(false);
  const unavailable = report.issues.filter((issue) => issue.message.includes("not executed during code_check"));
  expect(unavailable.length).toBeGreaterThan(0);
  expect(unavailable.every((issue) => issue.severity === "warning")).toBe(true);
  expect(report.passed).toBe(true);
}, 60000);

test("report links do not require main-flow steps", async () => {
  const { report } = await check("<main><h1>Report</h1><p>Total 12</p><a href='https://example.com'>Source</a></main>");
  expect(report.issues.some((issue) => issue.kind === "steps")).toBe(false);
}, 60000);

test("aria preserves direct list and definition text without repeating table names", async () => {
  const { report } = await check(
    "<main><h1>Records</h1><ul><li>Alpha record</li><li>Beta record</li></ul><dl><dt>Total</dt><dd>99 EUR</dd></dl><table><tr><th>Name</th><td>Ada</td></tr></table></main>",
  );
  for (const text of ["Alpha record", "Beta record", "99 EUR"]) expect(report.aria).toContain(text);
  expect(report.aria).not.toContain('table "Name Ada"');
  expect(report.aria).not.toContain('rowgroup "Name Ada"');
}, 60000);

test("reload preserves the current app hash", async () => {
  const { report } = await check(
    "<main><h1>Filters</h1><button type=button>Open</button><p role=status></p></main>",
    "document.querySelector('button').addEventListener('click', () => { location.hash = 'open'; }); document.querySelector('[role=status]').textContent = 'filter ' + location.hash.slice(1);",
    [{ action: "click", target: { role: "button", name: "Open" } }, { action: "reload" }],
  );
  expect(report.aria).toContain("filter open");
  expect(report.passed).toBe(true);
}, 60000);

test("select steps reject disabled controls", async () => {
  const { report } = await check(
    "<main><h1>Disabled</h1><label>Filter<select disabled><option value=open>Open</option></select></label></main>",
    "",
    [{ action: "select", target: { label: "Filter" }, value: "open" }],
  );
  expect(report.issues).toContainEqual(expect.objectContaining({ kind: "step", message: expect.stringContaining("Target is disabled") }));
}, 60000);

test("startup mobile overflow survives steps that remove the wide element", async () => {
  const { report } = await check(
    "<main><h1>Layout</h1><div id=wide>Wide</div><button type=button>Hide</button></main>",
    "document.querySelector('button').addEventListener('click', () => { document.querySelector('#wide').remove(); });",
    [{ action: "click", target: { role: "button", name: "Hide" } }],
    "#wide{width:700px}",
  );
  expect(report.issues).toContainEqual(expect.objectContaining({ kind: "overflow", severity: "error", view: "mobile" }));
}, 60000);

test("concurrent downloads are bounded before reaching the exposed save function", async () => {
  // Stay within the bridge budget so concurrent batches reach the download budget.
  const { report, downloadCalls } = await check(
    "<main><h1>Downloads</h1></main>",
    `for (let offset = 0; offset < ${CHECK_LIMITS.downloads + 5}; offset += ${LIMITS.pendingRequests}) {
      await Promise.allSettled(Array.from({length: Math.min(${LIMITS.pendingRequests}, ${CHECK_LIMITS.downloads + 5} - offset)},
        (_, i) => cloud.download('file' + (offset + i) + '.txt', 'tiny')));
    }`,
  );
  expect(report.downloads.length).toBeLessThanOrEqual(CHECK_LIMITS.downloads);
  expect(downloadCalls).toHaveLength(2);
  expect(downloadCalls[0]).toBe(CHECK_LIMITS.downloads);
  for (const count of downloadCalls) expect(count).toBeLessThanOrEqual(CHECK_LIMITS.downloads);
}, 60000);

const pngHeight = (bytes: Uint8Array | undefined) => (bytes ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) : 0);

test("siblings offset in one row and captions out of line warn with a concrete fix", async () => {
  // The three shapes the Studio evaluation found: a flex label/value pair, a flex button pair, a field row with a different caption cell.
  const { report } = await check(
    `<main><h1>Quote</h1>
    <div class="position"><label>Description<input></label><label>Quantity<input></label><div class="line"><span>Line total</span><strong>12,00 €</strong></div><button type="button">Remove</button></div>
    <div class="totals"><div><span>Net</span><strong>319,98 €</strong></div></div>
    <div class="actions"><button type="button">Edit</button><button type="button">Delete</button></div></main>`,
    "",
    [{ action: "click", target: { role: "button", name: "Edit" } }],
    `.position{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:12px;align-items:end}.position>*{margin:0}
    .line{display:flex;flex-direction:column;gap:12px;padding-bottom:9px;text-align:right}
    .totals>div{display:flex;justify-content:space-between}.actions{display:flex;gap:8px}`,
  );
  const desktop = report.issues.filter((issue) => issue.kind === "misaligned" && issue.view === "desktop");
  expect(desktop.every((issue) => issue.severity === "warning")).toBe(true);
  expect(desktop.map((issue) => issue.message)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^strong "319,98 €" sits 16px lower than span "Net" in one row of div\.totals > div \(flex\).*`div\.totals > div > \* \{ margin: 0 \}`/,
      ),
      expect.stringMatching(
        /^button "Delete" sits 16px lower than button "Edit" in one row of div\.actions \(flex\).*`div\.actions > \* \{ margin: 0 \}`/,
      ),
      expect.stringMatching(
        /^The caption of div\.line "Line total 12,00 €" starts \d+px higher than the field captions beside it in one row of div\.position \(grid\)/,
      ),
    ]),
  );
  expect(report.passed).toBe(true);
}, 60000);

test("intentional alignment does not warn: base helpers, baseline, centered headers, wrapped rows, spans and auto margins", async () => {
  const { report } = await check(
    `<main><header class="row"><div><h1>Expenses</h1><p class="muted">Submit and approve</p></div><button type="button" class="primary">Export</button></header>
    <form class="row"><label>Name<input></label><label>City<input></label><button>Add</button></form>
    <div class="grid"><div class="stat"><span>Open requests this month</span><strong>2</strong></div><div class="stat"><span>Pending</span><strong>62,40 €</strong></div><div class="stat"><span>Approved</span><strong>49,90 €</strong></div></div>
    <div class="baseline"><span class="big">Total</span><span>small</span><small>note</small></div>
    <div class="wrap">${Array.from({ length: 14 }, (_, i) => `<span style="height:${20 + (i % 3) * 10}px">Item ${i + 1}</span>`).join("")}</div>
    <div class="split"><aside>Side</aside><p>First</p><p>Second</p></div>
    <div class="pushed"><span>Top</span><span class="end">Bottom</span></div>
    <div class="pairs"><div><span>Net</span><strong>319,98 €</strong></div></div>
    <ul><li><label><input type="checkbox" class="nudge"> Send invoice</label><button type="button" class="danger">Delete</button></li></ul>
    <dl><dt>Total</dt><dd>99 €</dd></dl></main>`,
    "",
    [{ action: "click", target: { role: "button", name: "Export" } }],
    `.baseline{display:flex;align-items:baseline;gap:8px}.baseline .big{font-size:2rem}
    .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:300px}.wrap>*{margin:0}
    .split{display:grid;grid-template-columns:1fr 1fr;gap:8px}.split>*{margin:0}.split aside{grid-row:span 2}
    .pushed{display:flex;height:80px;gap:8px}.pushed>*{margin:0}.pushed .end{margin-top:auto}
    .pairs>div{display:flex;justify-content:space-between}.pairs>div>*{margin:0}.nudge{margin-top:3px}`,
  );
  expect(report.issues.filter((issue) => issue.kind === "misaligned")).toEqual([]);
  expect(report.passed).toBe(true);
}, 60000);

test("a caught error shown in the page fails the check; broken values warn", async () => {
  const { report } = await check(
    "<main><h1>Expenses</h1><form><label>Comment<input name=comment></label><button>Save</button></form><p role=alert hidden></p><p id=total></p></main>",
    `const form = document.querySelector('form'), alert = document.querySelector('[role=alert]');
    document.querySelector('#total').textContent = 'Total: ' + Number(undefined) + ' €';
    form.addEventListener('submit', async (event) => {
      try { await cloud.kv.user.get('draft'); event.currentTarget.elements.comment.value; }
      catch (error) { alert.textContent = error.message; alert.hidden = false; }
    });`,
    [{ action: "click", target: { role: "button", name: "Save" } }],
  );
  expect(report.passed).toBe(false);
  const shown = report.issues.filter((issue) => issue.kind === "shown-error");
  expect(shown).toHaveLength(2);
  for (const issue of shown) {
    expect(issue.severity).toBe("error");
    // Chromium and WebKit word the same TypeError differently; both are recognized.
    expect(issue.message).toMatch(
      /^After step 1: The page shows a JavaScript error: "(?:Cannot read properties of null \(reading 'elements'\)|null is not an object \(evaluating 'event\.currentTarget\.elements'\))"/,
    );
  }
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: "shown-value", severity: "warning", message: expect.stringContaining('"Total: NaN €"') }),
  );
}, 60000);

test("errors thrown in event handlers and unhandled rejections fail the check", async () => {
  const { report } = await check(
    "<main><h1>Handlers</h1><button type=button id=a>Sync</button><button type=button id=b>Async</button></main>",
    `document.querySelector('#a').addEventListener('click', () => { throw new Error('handler broke'); });
    document.querySelector('#b').addEventListener('click', async () => { await null; throw new Error('async broke'); });`,
    [
      { action: "click", target: { role: "button", name: "Sync" } },
      { action: "click", target: { role: "button", name: "Async" } },
    ],
  );
  expect(report.passed).toBe(false);
  for (const text of ["handler broke", "Unhandled rejection: Error: async broke"])
    for (const view of ["desktop", "mobile"])
      expect(report.issues).toContainEqual(
        expect.objectContaining({ kind: "uncaught", severity: "error", view, message: expect.stringContaining(text) }),
      );
}, 60000);

test("screenshots cover the whole page up to the height limit", async () => {
  const short = await check("<main><h1>Long</h1><div style='height:1500px'>Tall</div><p>End of the list</p></main>");
  const height = pngHeight(short.saved.get("desktop-light.png"));
  expect(height).toBeGreaterThan(1500);
  expect(height).toBeLessThan(CHECK_LIMITS.screenshotHeight);
  expect(pngHeight(short.saved.get("desktop-start-light.png"))).toBe(height);
  expect(pngHeight(short.saved.get("mobile-dark.png"))).toBeGreaterThan(1500);
  expect(short.report.screenshots.every((shot) => !shot.cropped)).toBe(true);
  const long = await check("<main><h1>Longer</h1><div style='height:5000px'>Tall</div></main>");
  expect(pngHeight(long.saved.get("desktop-light.png"))).toBe(CHECK_LIMITS.screenshotHeight);
  expect(long.report.screenshots.every((shot) => shot.cropped)).toBe(true);
}, 90000);

test("PDF HTML is measured at its printed width before it is rendered", async () => {
  const { report } = await check(
    "<main><h1>Report</h1><button type=button>PDF</button><p role=status></p></main>",
    `document.querySelector('button').addEventListener('click', async () => {
      await cloud.pdf.render({ html: cloud.html\`<style>.sign{display:flex;gap:32px}.sign>div{flex:1}</style><h1>Travel expenses</h1><p>Total: \${Number(undefined)} €</p><div class="sign"><div><p>Place, date</p></div><div><p>Signature</p></div></div>\` });
      document.querySelector('[role=status]').textContent = 'PDF ready';
    });`,
    [{ action: "click", target: { role: "button", name: "PDF" } }],
  );
  expect(report.aria).toContain("PDF ready");
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      kind: "pdf-misaligned",
      severity: "warning",
      view: "desktop",
      message: expect.stringMatching(
        /^In the PDF: div "Signature" sits 16px lower than div "Place, date" in one row of div\.sign \(flex\).*`div\.sign > \* \{ margin: 0 \}`/,
      ),
    }),
  );
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      kind: "pdf-shown-value",
      severity: "warning",
      message: expect.stringContaining('The PDF shows a broken value: "Total: NaN €"'),
    }),
  );
}, 60000);
