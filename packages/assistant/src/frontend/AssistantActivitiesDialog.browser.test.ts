import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AiChatTaskOccurrenceView, AiChatTaskView, AiStoredMessage } from "@k2b/cloud/ai";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// Whether a result table fits the dialog's scroll box is a result of the shipped cascade, which happy-dom does not
// lay out, so a real engine opens the real run dialog.
const task: AiChatTaskView = {
  id: "task01",
  chatId: "chat01",
  chatTitle: "Morning chat",
  grants: [],
  prompt: "Weekly plan",
  schedule: { kind: "cron", cron: "0 9 * * 1" },
  timezone: "UTC",
  state: "active",
  lastError: null,
  createdAt: "2026-09-20T09:00:00Z",
  updatedAt: "2026-09-20T09:00:00Z",
};
const occurrence: AiChatTaskOccurrenceView = {
  id: "run001",
  taskId: task.id,
  scheduledFor: "2026-09-21T09:00:00Z",
  trigger: "scheduled",
  state: "completed",
  error: null,
  resultText: "Here is the plan for this week.\n\n| Format | When |\n| --- | --- |\n| Reel | Wed |\n| Review | Sat |",
  createdAt: "2026-09-21T09:00:00Z",
  startedAt: null,
  completedAt: null,
};
const message: AiStoredMessage = {
  id: "message",
  shortId: "msg001",
  conversationId: "chat01",
  seq: 1,
  kind: "message",
  message: { role: "user", content: [{ type: "text", text: "Plan the week." }] },
  loopId: "run001",
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-09-21T09:00:00Z",
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const build = Bun.spawn(
    ["bun", new URL("../artifacts/workspace-browser-build.ts", import.meta.url).pathname, "../frontend/activity-run-browser-harness.tsx"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [bundle, buildError] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(buildError);
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const css = await Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] });
  if (!css.success) throw new Error(css.logs.join("\n"));
  const appCss = await css.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/app.css") return new Response(appCss, { headers: { "content-type": "text/css" } });
      if (path === "/api/ai/tasks/task01/occurrences/run001") return Response.json({ task, occurrence, messages: [message] });
      if (path.startsWith("/api/")) return new Response("Not found", { status: 404 });
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0"><script src="/bundle.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

for (const width of [390, 1280]) {
  test(`a run result's Markdown table fits the dialog's scroll box at ${width} px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(server.url.href);
      await page.locator(".assistant-activity-result .k2b-content-markdown__table").waitFor();
      const fit = await page.evaluate(() => {
        // `+ 0` turns WebKit's sub-pixel `-0` into `0`.
        const round = (value: number) => Math.round(value * 10) / 10 + 0;
        const body = document.querySelector<HTMLElement>(".assistant-activity-dialog__body")!;
        const region = document.querySelector<HTMLElement>(".k2b-dialog__content")!;
        const wrap = body.querySelector(".k2b-content-markdown__table")!.getBoundingClientRect();
        const left = body.getBoundingClientRect().left + body.clientLeft;
        const right = left + body.clientWidth;
        return {
          sideways: body.scrollWidth - body.clientWidth,
          // The table's lines reach past the text, inside the box that clips them.
          inside: wrap.left >= left - 0.5 && wrap.right <= right + 0.5,
          // The result's text stays on the dialog's content edge.
          text: round(
            body.querySelector(".assistant-activity-result p")!.getBoundingClientRect().left -
              (region.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(region).paddingLeft)),
          ),
        };
      });
      expect(fit).toEqual({ sideways: 0, inside: true, text: 0 });
    } finally {
      await page.close();
    }
  });
}
