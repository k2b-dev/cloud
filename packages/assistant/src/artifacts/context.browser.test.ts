import { expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";

test("chat workspace opens file and source context without loading Studio", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./context-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(error);
  const requests: string[] = [];
  const app = {
    id: "AAAAA2",
    title: "Sales dashboard",
    description: "Sales by region",
    kind: "app",
    icon: "ti ti-chart-bar",
    permission: "admin",
    revision: 1,
    publishedRevision: null,
    publishedVersion: null,
    updatedAt: "2030-01-02T12:00:00.000Z",
    forkedFromId: null,
    forkedFromRevision: null,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
      if (path.endsWith("/context"))
        return Response.json({
          chatId: "chat-one",
          viewerUserId: "test",
          now: "2030-01-02T12:00:00.000Z",
          timeZone: "UTC",
          results: [
            {
              key: `assistant.artifact:${app.id}`,
              kind: "app",
              title: app.title,
              description: app.description,
              icon: app.icon,
              deliveredAt: "2030-01-02T12:00:00.000Z",
              turnId: "turn-1",
              callId: "open-1",
              messageSeq: 2,
              app: { id: app.id, href: `/app/assistant/apps/${app.id}`, published: false, lastRun: null },
            },
          ],
          resultsTruncated: false,
          apps: [app],
          files: [],
          fileCount: 0,
          working: { groups: [], groupCount: 0, looseFiles: [], count: 0, bytes: 0 },
          storage: { usedBytes: 0, maxBytes: 262144000 },
          tasks: [],
          sources: [],
          sourceCount: 0,
          sourceCursor: null,
          skills: [],
          memories: [],
          runCount: 3,
          runs: [{ id: "run-1", status: "ready", createdAt: "2030-01-02T12:00:00.000Z" }],
        });
      if (path.endsWith("/AAAAA2"))
        return Response.json({
          ...app,
          sourceRevision: 1,
          source: { entry: "index.html", files: [{ path: "index.html", content: "<main><p>Fixture</p></main>" }] },
        });
      if (path.endsWith("/app-assets")) return Response.json({ message: "Fixture stops at execution boundary" }, { status: 500 });
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0"><div id="root"></div><script type="module" src="/bundle.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(3000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    const context = page.locator("#assistant-chat-context");
    // One-off runs stay one level deeper, as a row under working files.
    await context.getByRole("button", { name: /Working files/ }).click();
    expect(await context.getByRole("button", { name: /Script runs · 3/ }).count()).toBe(1);
    await page.locator(".assistant-context-open").getByRole("button", { name: "Open", exact: true }).click();
    expect(await page.getByRole("menuitem", { name: "Studio", exact: true }).count()).toBe(0);
    await page.getByRole("menuitem", { name: "Sources", exact: true }).click();
    await page.getByRole("tab", { name: "Sources", exact: true }).waitFor();
    expect(await page.locator(".assistant-studio-card").count()).toBe(0);
    expect(requests.some((path) => path.includes("/artifacts/"))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 20000);
