// Reload check: the first painted frame of a reload already shows the final page. Nothing appears late (text, fonts),
// nothing moves (layout shifts), and hydration changes no visible DOM.
// Usage: bun test/reload.ts [chromium|webkit] [--base http://localhost:4392] [--latency 60] [--dev] [--frames <dir>]
// Without --base it starts its own server (production mode, or development with --dev) and stops it at the end.
// --latency adds round-trip time per request (CDP, Chromium only), as a visitor over the internet sees it.
import { type Browser, type Page, chromium, webkit } from "playwright";

const argument = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const engineName = process.argv[2] === "webkit" ? "webkit" : "chromium";
const engine = engineName === "webkit" ? webkit : chromium;
const latency = Number(argument("--latency") ?? 60);
const framesDir = argument("--frames");
const root = `${import.meta.dir}/..`;
const port = 4400 + Math.floor(Math.random() * 400);
const base = argument("--base") ?? `http://localhost:${port}`;
const server = argument("--base")
  ? undefined
  : Bun.spawn(["bun", "--conditions=solid", "--preload=./scripts/preload.ts", "src/server.tsx"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: process.argv.includes("--dev") ? "development" : "production", PORT: String(port) },
      stdout: "ignore",
      stderr: "inherit",
    });

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${engineName} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

type Probe = {
  shifts: { value: number; at: number; sources: string[] }[];
  mutations: { at: number; what: string }[];
};

// Runs in the page before any of its own code: records layout shifts and every DOM change after the parser finished
// (that is, everything hydration and island scripts do).
const probe = () => {
  const describe = (node: Node | null): string => {
    if (!node) return "?";
    if (node.nodeType === Node.TEXT_NODE) return `#text${JSON.stringify(node.textContent)}`;
    if (!(node instanceof Element)) return node.nodeName;
    const element = node as Element;
    return `${element.localName}${element.id ? `#${element.id}` : ""}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`;
  };
  const state: Probe = { shifts: [], mutations: [] };
  (globalThis as unknown as { __probe: Probe }).__probe = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] })[]) {
      if (entry.hadRecentInput) continue;
      state.shifts.push({ value: entry.value, at: Math.round(entry.startTime), sources: (entry.sources ?? []).map((source) => describe(source.node ?? null)) });
    }
  }).observe({ type: "layout-shift", buffered: true });
  document.addEventListener("readystatechange", () => {
    if (document.readyState !== "interactive") return;
    new MutationObserver((records) => {
      for (const record of records) {
        // Only the page counts (not the dev tools badge of development mode); a visually hidden live region, the
        // overlay scrollbar and the island's own hydration marker are not visible.
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target?.closest(".k2-shell") || target.closest(".k2-sr, .k2-scrollbar")) continue;
        if (record.type === "attributes" && record.attributeName === "data-hydrated") continue;
        // Solid's hydration adds empty text nodes as insert markers; they draw nothing.
        const drawn = (nodes: NodeList) => [...nodes].filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent !== "");
        if (record.type === "childList" && drawn(record.addedNodes).length === 0 && drawn(record.removedNodes).length === 0) continue;
        const what =
          record.type === "attributes"
            ? `attr ${record.attributeName} on ${describe(record.target)}`
            : record.type === "characterData"
              ? `text in ${describe(target)}`
              : `children of ${describe(record.target)} +${[...record.addedNodes].map(describe).join(",")} -${[...record.removedNodes].map(describe).join(",")}`;
        state.mutations.push({ at: Math.round(performance.now()), what });
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
};

// Compares screencast frames in a blank page: share of pixels that differ from the final frame.
const diffFrames = async (browser: Browser, frames: string[]) => {
  const page = await browser.newPage();
  const result = await page.evaluate(async (list) => {
    const decode = async (data: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const last = await decode(list[list.length - 1]);
    const out: number[] = [];
    for (const data of list) {
      const pixels = await decode(data);
      let changed = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - last[i]) + Math.abs(pixels[i + 1] - last[i + 1]) + Math.abs(pixels[i + 2] - last[i + 2]) > 24) changed++;
      }
      out.push(changed / (pixels.length / 4));
    }
    return out;
  }, frames);
  await page.close();
  return result;
};

const reload = async (browser: Browser, path: string, scheme: "light" | "dark") => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page: Page = await context.newPage();
  await page.addInitScript(probe);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  const cdp = engineName === "chromium" ? await context.newCDPSession(page) : undefined;
  if (cdp && latency > 0) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
  }
  // The first visit fills the cache; the check is the reload a person does.
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  const frames: { at: number; data: string }[] = [];
  if (cdp) {
    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      frames.push({ at: frame.metadata.timestamp ?? 0, data: frame.data });
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  }
  const requested = Date.now() / 1000;
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  if (cdp) await cdp.send("Page.stopScreencast");
  const state = await page.evaluate(() => (globalThis as unknown as { __probe: Probe }).__probe);
  const name = `${path} ${scheme}`;
  const cls = state.shifts.reduce((sum, shift) => sum + shift.value, 0);
  check(`${name}: no layout shift after reload (CLS ${cls.toFixed(4)})`, cls === 0, state.shifts);
  // A reload takes the faces from the cache, so nothing waits for the network before the text can be drawn.
  const fonts = await page.evaluate(() =>
    (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.name.includes("/fonts/"))
      .map((entry) => ({ font: entry.name.split("/").pop(), transferSize: entry.transferSize })),
  );
  check(`${name}: the reload takes all three font faces from the cache`, fonts.length === 3 && fonts.every((font) => font.transferSize === 0), fonts);
  check(`${name}: no errors (an island that fails to hydrate logs one and renders again)`, errors.length === 0, errors);
  const kinds = Object.entries(Object.groupBy(state.mutations, (mutation) => mutation.what)).map(([what, list]) => `${list?.length}× ${what}`);
  check(`${name}: hydration changes no visible DOM`, state.mutations.length === 0, kinds);
  if (cdp && frames.length) {
    // Frames before the reload's first paint still show the old page; the white frame in between is the browser's.
    const after = frames.filter((frame) => frame.at >= requested);
    const diffs = await diffFrames(browser, after.map((frame) => frame.data));
    const first = diffs.findIndex((share) => share < 0.5);
    const late = diffs.slice(first).map((share, index) => ({ frame: first + index, ms: Math.round((after[first + index].at - after[first].at) * 1000), share: Number(share.toFixed(4)) }));
    const changed = late.filter((entry) => entry.share > 0.0005);
    console.log(`     ${name}: ${after.length} frames, first content frame ${first}, later changes ${JSON.stringify(changed)}`);
    check(`${name}: the first content frame is the final page`, first >= 0 && changed.length === 0, changed);
    if (framesDir) {
      for (const [index, frame] of after.entries())
        await Bun.write(`${framesDir}/${path.replace(/\W+/g, "_")}-${scheme}-${String(index).padStart(2, "0")}.png`, Buffer.from(frame.data, "base64"));
    }
  }
  await context.close();
};

// A token the system theme sets for dark but the explicit dark theme does not (or the reverse) is a dark bug in one of
// the two ways to get there.
const darkBlocks = async () => {
  const css = await Bun.file(`${root}/../../packages/ui/src/v2/v2.css`).text();
  const names = (block: string) => [...block.matchAll(/(--k2-[\w-]+)\s*:/g)].map((match) => match[1]).sort();
  const system = /:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const explicit = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const a = names(system);
  const b = names(explicit);
  check("v2.css: the system and the explicit dark theme set the same tokens", a.length > 0 && a.join() === b.join(), {
    onlySystem: a.filter((name) => !b.includes(name)),
    onlyExplicit: b.filter((name) => !a.includes(name)),
  });
};

// A hovered row keeps its text readable (WCAG 4.5:1 between the row fill and its text) in both themes.
const hoverContrast = async (browser: Browser, scheme: "light" | "dark") => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await page.goto(`${base}/mail`, { waitUntil: "networkidle" });
  const row = page.locator("a.k2-row").nth(3);
  await row.hover();
  await page.waitForTimeout(100);
  const ratio = await row.evaluate((element) => {
    const rgb = (color: string) => {
      const context = new OffscreenCanvas(1, 1).getContext("2d") as OffscreenCanvasRenderingContext2D;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = (color: string) => {
      const [r, g, b] = rgb(color).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const text = getComputedStyle(element.querySelector(".k2-row__line span") ?? element).color;
    const [high, low] = [luminance(getComputedStyle(element).backgroundColor), luminance(text)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  });
  check(`${scheme}: a hovered row keeps its text readable (contrast ${ratio.toFixed(1)})`, ratio >= 4.5);
  await page.close();
};

try {
  await darkBlocks();
  for (let i = 0; i < 200; i++) {
    if (await fetch(`${base}/mail`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  const browser = await engine.launch();
  for (const path of ["/mail", "/mail?id=m1", "/dnd"]) for (const scheme of ["light", "dark"] as const) await reload(browser, path, scheme);
  for (const scheme of ["light", "dark"] as const) await hoverContrast(browser, scheme);
  await browser.close();
} finally {
  server?.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
