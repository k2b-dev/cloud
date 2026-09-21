import { expect, test } from "bun:test";
import { chromium } from "playwright";

for (const kind of ["apps", "skills"] as const)
  test(`project ${kind} can be searched, linked and unlinked while readers have no controls`, async () => {
    const add = kind === "apps" ? "Link a Studio App" : "Link a Skill";
    const searchLabel = kind === "apps" ? "Search Studio Apps…" : "Search Skills…";
    const empty = kind === "apps" ? "No linked apps yet." : "No linked Skills yet.";
    const notice =
      kind === "apps"
        ? "Members can use linked, published apps and their shared app data. Editing permissions stay unchanged."
        : "Members can read and use linked Skills. Editing permissions stay unchanged.";
    const build = Bun.spawn(
      ["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./project-apps-browser-harness.tsx"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await new Response(build.stdout).text();
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
    let linked = true;
    let listRequests = 0;
    let failList = true;
    const writes: boolean[] = [];
    const searches: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
        if (url.pathname === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
        if (url.pathname.endsWith("/project-links/project1")) {
          listRequests++;
          if (failList) return Response.json({ message: "Temporary failure" }, { status: 503 });
          const available = url.searchParams.get("available") === "true";
          searches.push(url.searchParams.get("q") ?? "");
          const item =
            kind === "apps"
              ? { id: "app123", title: "Bank reconciliation", icon: "ti ti-app-window", published: false, canManage: true, linked }
              : {
                  id: "app123",
                  shortId: "app123",
                  name: "Bank reconciliation",
                  description: "Reconcile statements.",
                  permission: "admin",
                  enabled: true,
                  revision: 1,
                  referenceCount: 0,
                  createdAt: "",
                  updatedAt: "",
                };
          return Response.json({ items: available !== linked ? [item] : [], page: 1, hasNext: false });
        }
        if (url.pathname.endsWith("/app123/projects/project1")) {
          linked = (await request.json()).linked;
          writes.push(linked);
          return Response.json({ linked });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(new URL(`/${kind}`, server.url).href);
      await page.getByText("Bank reconciliation", { exact: true }).waitFor();
      expect(listRequests).toBe(0);
      expect(await page.getByText("Loading Studio Apps…", { exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Unlink · Bank reconciliation", exact: true }).click();
      await page.getByText("Could not load linked resources.", { exact: false }).waitFor();
      failList = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByText(empty, { exact: true }).waitFor();
      await page.getByRole("button", { name: add, exact: true }).click();
      await page.getByText(notice, { exact: true }).waitFor();
      await page.getByRole("dialog").getByText("Bank reconciliation", { exact: true }).waitFor();
      await Promise.all([
        page.waitForResponse((response) => response.url().includes("q=Bank")),
        page.getByPlaceholder(searchLabel).fill("Bank"),
      ]);
      await page.getByText("Bank reconciliation", { exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .getByText(kind === "apps" ? "Draft — publish before members can use it." : "Reconcile statements.", { exact: true })
        .waitFor();
      expect(writes).toEqual([false, true]);
      expect(searches).toContain("Bank");
      await page.getByRole("button", { name: "Unlink · Bank reconciliation", exact: true }).click();
      await page.getByText(empty, { exact: true }).waitFor();
      expect(writes).toEqual([false, true, false]);
      // Cancelling the picker never changes project links.
      await page.getByRole("button", { name: add, exact: true }).click();
      await page.getByPlaceholder(searchLabel).waitFor();
      await page.keyboard.press("Escape");
      expect(writes).toEqual([false, true, false]);
      linked = true;
      await page.goto(new URL(`/${kind}/reader`, server.url).href);
      await page.getByText("Bank reconciliation", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: add, exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Unlink · Bank reconciliation", exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.stop(true);
    }
  }, 60000);
