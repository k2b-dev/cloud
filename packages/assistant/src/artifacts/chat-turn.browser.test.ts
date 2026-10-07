import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { compileArtifact } from "./runtime/compile";

// Where things stand when a long turn ends needs a real layout engine. The harness scripts one live turn with a Studio
// preview, a delivered file, an approval, and a final answer, and turns it into history the way the server does.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const code = `export default () => {
  const total = ui.stat({id:"total",label:"Total",value:20});
  ui.row({id:"metrics",children:[total,ui.stat({id:"maintenance",label:"Maintenance",value:4})]});
  ui.slider({id:"quantity",label:"Quantity",min:1,max:20,value:2,onChange:value=>total.setValue(value*10)});
}`;
const nodes = [
  { id: "total", type: "stat", label: "Total", value: 20 },
  { id: "maintenance", type: "stat", label: "Maintenance", value: 4 },
  { id: "metrics", type: "layout", layout: "row", children: ["total", "maintenance"] },
  { id: "quantity", type: "slider", label: "Quantity", min: 1, max: 20, value: 2 },
];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const counts = { presentation: 0, compile: 0 };

beforeAll(async () => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./chat-turn-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bundle, buildError, styles, appStyles, source] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    Bun.build({ entrypoints: [new URL("../../../../styles.css", import.meta.url).pathname], plugins: [tailwind] }),
    Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] }),
    compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] }),
  ]);
  if (await build.exited) throw new Error(buildError);
  if (!styles.success || !appStyles.success) throw new AggregateError([...styles.logs, ...appStyles.logs], "Stylesheets did not build.");
  const css = (await styles.outputs[0]!.text()) + (await appStyles.outputs[0]!.text());
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/api/assistant/artifacts/runtime/compile") {
        counts.compile++;
        return Response.json(source);
      }
      if (path.startsWith("/api/assistant/artifacts/presentations/")) {
        counts.presentation++;
        return Response.json({
          id: "00000000-0000-4000-8000-000000000001",
          conversationId: "abc234",
          title: "Inventory",
          code,
          nodes,
          inputs: [],
        });
      }
      if (path !== "/") return new Response(null, { status: 404 });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css} html,body,#root{height:100%;margin:0} .harness-chat{height:100%}</style></head>` +
          `<body class="k2b-ui bg-surface"><div id="root"></div><script src="/bundle.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

type Box = { top: number; height: number } | null;
const measure = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector(".k2b-chat-timeline__content")!.getBoundingClientRect().top;
    const box = (selector: string): { top: number; height: number } | null => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round((rect.top - content) * 2) / 2, height: Math.round(rect.height * 2) / 2 };
    };
    return {
      work: box(".ai-turn-work > summary"),
      file: box('.ai-turn [title="/orders-joined.csv"]'),
      view: box(".assistant-chat-presentation"),
      text: box(".ai-turn__text"),
      receipt: box(".ai-turn__action"),
    };
  });
const step = (page: Page, name: string) =>
  page.evaluate((key) => (window as unknown as { turn: Record<string, () => void> }).turn[key]!(), name);
/** Waits until screen readers were told `text` through the shared polite live region. */
const announced = (page: Page, text: string) =>
  page.waitForFunction(
    (expected) => document.querySelector('[data-k2b-live] [data-politeness="polite"]')?.textContent?.includes(expected),
    text,
  );

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a finished turn keeps every place and the running Studio session at ${viewport.width} px`, async () => {
    counts.presentation = 0;
    counts.compile = 0;
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 600 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(server.url.href);
      await page.getByText("Build an inventory dashboard").waitFor();

      // Live: the work line names the step, results and the newest status stay visible.
      await step(page, "start");
      const placeholder = page.locator(".assistant-chat-presentation");
      await placeholder.waitFor();
      const reserved = (await placeholder.boundingBox())!.height;
      expect(reserved).toBeGreaterThan(200);
      expect(await page.locator(".ai-turn__text").textContent()).toContain("Now I build the dashboard.");
      expect(await page.locator(".ai-turn").textContent()).not.toContain("I read the four files first.");
      // The log does not read the ticking work line or a streaming status; a status is announced once it is complete.
      expect(await page.locator(".ai-turn__work").getAttribute("aria-live")).toBe("off");
      expect(await page.locator(".ai-turn__text").getAttribute("aria-live")).toBe("off");
      await announced(page, "I read the four files first.");
      await step(page, "present");
      await page.getByRole("button", { name: "Interagieren", exact: true }).waitFor();
      expect((await placeholder.boundingBox())!.height).toBe(reserved);
      expect(counts.presentation).toBe(1);

      // Start the session and change a filter inside it.
      await page.getByRole("button", { name: "Interagieren", exact: true }).click();
      await page.locator('[data-artifact-id="quantity"] input:not([disabled])').waitFor();
      expect(counts.compile).toBe(1);
      await page.getByRole("slider").focus();
      await page.getByRole("slider").press("ArrowRight");
      await page.waitForFunction(() => document.querySelector('[data-artifact-id="total"]')?.textContent?.includes("30"));
      await placeholder.evaluate((element) => element.setAttribute("data-harness-view", "kept"));

      // Approve in place: the card becomes its receipt where it stood, and focus stays there without scrolling.
      await step(page, "approval");
      const card = page.getByRole("region", { name: "Freigabe erforderlich: Send email" });
      await card.waitFor();
      await announced(page, "Freigabe nötig: Send email");
      expect(await page.locator(".ai-turn-work > summary").textContent()).toContain("Wartet auf deine Freigabe");
      const cardTop = (await measure(page)).receipt!.top;
      const scrollTop = await page.locator(".k2b-chat-timeline__viewport").evaluate((element) => element.scrollTop);
      await card.getByRole("button", { name: "Send email", exact: true }).click();
      await page.getByText("Email to Jana Berger sent").waitFor();
      expect((await measure(page)).receipt!.top).toBe(cardTop);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("ai-turn__action"))).toBe(true);
      if (viewport.width > 600) {
        // Everything above the composer fits: neither the decision nor the focus moved the conversation.
        expect(await page.locator(".k2b-chat-timeline__viewport").evaluate((element) => element.scrollTop)).toBe(scrollTop);
      }

      await step(page, "answer");
      await page.getByText("Inventory is ready.").waitFor();
      const before = await measure(page);
      expect(Object.values(before).every((box: Box) => box !== null)).toBe(true);

      // The turn ends: the same elements stay in place; only the work line text and the message actions change.
      await step(page, "finish");
      await page.getByRole("button", { name: "Copy" }).waitFor();
      await announced(page, "Antwort fertig");
      const after = await measure(page);
      expect(after).toEqual(before);
      expect(await page.locator('[data-harness-view="kept"]').count()).toBe(1);
      expect(counts.presentation).toBe(1);
      expect(counts.compile).toBe(1);
      expect(await page.getByRole("button", { name: "Stoppen", exact: true }).count()).toBe(1);
      expect(await page.locator('[data-artifact-id="total"]').textContent()).toContain("30");
      expect(await page.locator(".ai-turn-work > summary").textContent()).toBe("3 Min. gearbeitet6 Schritte");
      expect(await page.locator(".ai-turn").textContent()).not.toContain("Now I build the dashboard.");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `/tmp/assistant-turn-${browserName}-${viewport.width}.png`, fullPage: false });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("a new version of a view takes the earlier place without a frame of its own first", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(server.url.href);
    await page.getByText("Build an inventory dashboard").waitFor();
    await step(page, "start");
    await step(page, "present");
    await page.getByRole("button", { name: "Interagieren", exact: true }).waitFor();
    const frames = page.locator(".assistant-chat-presentation");
    const before = await measure(page);
    for (const name of ["revise", "reviseArgs"]) {
      await step(page, name);
      expect(await frames.count()).toBe(1);
      const now = await measure(page);
      expect(now.view).toEqual(before.view);
      expect(now.text).toEqual(before.text);
    }
  } finally {
    await page.close();
  }
}, 60_000);

test("a stop while an approval waits leaves a not-run receipt at the card's place", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await page.goto(server.url.href);
    await page.getByText("Build an inventory dashboard").waitFor();
    await step(page, "start");
    await step(page, "present");
    await step(page, "approval");
    await page.getByRole("region", { name: "Freigabe erforderlich: Send email" }).waitFor();
    const before = await measure(page);
    await step(page, "stop");
    await page.getByText("Nicht ausgeführt: Send email · gestoppt").waitFor();
    const after = await measure(page);
    expect(after.receipt!.top).toBeLessThanOrEqual(before.receipt!.top);
    expect(after.work).toEqual(before.work);
    expect(after.file).toEqual(before.file);
    expect(after.view).toEqual(before.view);
    // Nobody decided this card, so focus stays where it was.
    expect(await page.evaluate(() => document.activeElement?.classList.contains("ai-turn__action"))).toBe(false);
    // A stopped turn has no valid status any more: its texts fold into the work line.
    expect(after.text).toBeNull();
    expect(await page.locator(".ai-turn-work > summary").textContent()).toBe("3 Min. gearbeitet · gestoppt6 Schritte");
  } finally {
    await page.close();
  }
}, 60_000);
