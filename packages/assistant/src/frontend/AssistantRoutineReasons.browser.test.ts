import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AiChatTaskOccurrenceView, AiChatTaskView, ChatTaskReasonCode } from "@k2b/cloud/ai";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// The routine's reason and the archive question are what a person reads when a routine stops, so a real engine
// renders the shipped dialog in light mode at desktop and phone widths, with a frozen clock.
const NOW = new Date("2026-10-17T09:00:00.000Z");
const STOPPED_AT = "2026-10-16T14:30:00.000Z";
const RAW_ERROR = "Scheduled task mandate revision changed";
const STATE: Record<ChatTaskReasonCode, AiChatTaskView["state"]> = {
  paused: "paused",
  chat_archived: "paused",
  owner_inactive: "paused",
  failed: "needs_attention",
  rights_changed: "needs_attention",
  needs_approval: "needs_attention",
};
const SENTENCES: Record<"en" | "de", Record<ChatTaskReasonCode, string>> = {
  en: {
    paused: "Paused by you on Oct 16, 2026, 16:30. What happens meanwhile is not caught up automatically.",
    chat_archived: "Paused because the chat is archived.",
    owner_inactive: "Paused because the account is inactive.",
    failed: "The last run failed.",
    rights_changed: "What it may do changed. Please confirm again.",
    needs_approval: "That needs your approval every time, and routines never ask.",
  },
  de: {
    paused: "Von dir pausiert am 16. Okt. 2026, 16:30. Was in der Pause passiert, wird nicht von selbst nachgeholt.",
    chat_archived: "Pausiert, weil der Chat archiviert ist.",
    owner_inactive: "Pausiert, weil das Konto inaktiv ist.",
    failed: "Der letzte Lauf ist fehlgeschlagen.",
    rights_changed: "Was sie darf, hat sich geändert. Bitte neu bestätigen.",
    needs_approval: "Das macht der Assistant nur mit dir, und Routinen fragen nie.",
  },
};

const task = (code: ChatTaskReasonCode): AiChatTaskView => ({
  id: `task-${code}`,
  chatId: "chat01",
  chatTitle: "Rechnungen",
  title: "Neue Rechnungen eintragen",
  name: "Neue Rechnungen eintragen",
  reason: { code, at: STOPPED_AT },
  grants: [],
  prompt: "Trage neue Rechnungen aus dem Ordner in die Tabelle ein.",
  schedule: { kind: "cron", cron: "0 8 * * 1-5" },
  timezone: "Europe/Berlin",
  state: STATE[code],
  lastError: STATE[code] === "needs_attention" ? RAW_ERROR : null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: STOPPED_AT,
  nextRunAt: null,
});
const occurrence = (code: ChatTaskReasonCode): AiChatTaskOccurrenceView => ({
  id: "run001",
  taskId: `task-${code}`,
  scheduledFor: "2026-10-16T06:00:00.000Z",
  trigger: "scheduled",
  state: STATE[code] === "needs_attention" ? "failed" : "completed",
  error: STATE[code] === "needs_attention" ? RAW_ERROR : null,
  resultText: SENTENCES.en[code],
  createdAt: "2026-10-16T06:00:00.000Z",
  startedAt: "2026-10-16T06:00:01.000Z",
  completedAt: "2026-10-16T06:01:00.000Z",
});

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let activeRoutines: AiChatTaskView[] = [];
const archivePosts: string[] = [];
beforeAll(async () => {
  const build = Bun.spawn(
    [
      "bun",
      new URL("../artifacts/workspace-browser-build.ts", import.meta.url).pathname,
      "../frontend/routine-reasons-browser-harness.tsx",
    ],
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
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/app.css") return new Response(appCss, { headers: { "content-type": "text/css" } });
      if (path === "/api/ai/tasks") return Response.json(url.searchParams.get("state") === "active" ? activeRoutines : []);
      const detail = /^\/api\/ai\/tasks\/task-([a-z_]+)$/.exec(path);
      if (detail) {
        const code = detail[1] as ChatTaskReasonCode;
        return Response.json({ task: task(code), occurrences: [occurrence(code)], permissions: [] });
      }
      if (request.method === "POST" && path.endsWith("/archive")) {
        archivePosts.push(path);
        return Response.json({ ok: true });
      }
      if (path.startsWith("/api/")) return new Response("Not found", { status: 404 });
      const lang = url.searchParams.get("lang") ?? "en";
      return new Response(
        `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0"><script src="/bundle.js"></script></body></html>`,
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

const open = async (width: number, search: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: "light", timezoneId: "Europe/Berlin" });
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url.href}?${search}`);
  return page;
};
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [1440, 390]) {
  for (const lang of ["en", "de"] as const) {
    for (const code of Object.keys(STATE) as ChatTaskReasonCode[]) {
      test(`the routine says why it stopped (${code}) in ${lang} at ${width} px`, async () => {
        const page = await open(width, `code=${code}&lang=${lang}`);
        try {
          const notice = page.locator(".assistant-task-detail__reason");
          await notice.waitFor();
          expect(await notice.locator(".k2b-notice-card__title").innerText()).toBe(SENTENCES[lang][code]);
          // The raw error waits behind Technical details; it is not part of what the notice says.
          const technical = page.locator(".assistant-task-detail__technical");
          if (STATE[code] === "needs_attention") {
            expect(await technical.getAttribute("open")).toBeNull();
            await technical.locator("summary").click();
            expect(await technical.innerText()).toContain(RAW_ERROR);
            expect(await notice.getByRole("button", { name: lang === "de" ? "Im Chat beheben" : "Fix in chat" }).count()).toBe(1);
          } else {
            expect(await technical.count()).toBe(0);
          }
          expect(await page.locator("body").innerText()).not.toContain(`task-${code}`);
          expect(await sideways(page)).toBe(0);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }

  test(`archiving a chat names the routines it pauses at ${width} px`, async () => {
    activeRoutines = [{ ...task("failed"), state: "active", reason: null, lastError: null }];
    archivePosts.length = 0;
    const page = await open(width, "view=archive&lang=de");
    try {
      await page.getByText("Archivieren", { exact: true }).first().click();
      await page.getByRole("button", { name: "Chat archivieren" }).click();
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog").last());
      await dialog.getByText("In diesem Chat läuft 1 Routine („Neue Rechnungen eintragen“). Archivieren pausiert sie.").waitFor();
      const archiveAnyway = dialog.getByRole("button", { name: "Trotzdem archivieren" });
      expect(await archiveAnyway.count()).toBe(1);
      expect(await sideways(page)).toBe(0);
      // Cancelling changes nothing.
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await page.getByText("In diesem Chat läuft 1 Routine").waitFor({ state: "detached" });
      expect(archivePosts).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("archiving a chat without running routines asks the plain question", async () => {
  activeRoutines = [];
  const page = await open(1440, "view=archive&lang=en");
  try {
    await page.getByText("Archive", { exact: true }).first().click();
    await page.getByRole("button", { name: "Archive chat" }).click();
    await page.getByText('Archive "Rechnungen"?').waitFor();
    expect(await page.getByText("routine runs in this chat").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);
