import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { compileArtifact } from "./runtime/compile";

test("Studio lists open details with all management actions; publication and versions remain usable", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./apps-browser-harness.tsx"], { stdout: "pipe", stderr: "pipe" });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: 'export default () => { ui.text({value:"Published calculator"}); };' }] });
  let publishedRevision: number | null = 1;
  let emptyHistory = false;
  let listRequests = 0;
  let longCatalog = false;
  let removed = false;
  const publicationNotes: string[] = [];
  const mutations: string[] = [], compiledVersions: string[] = [];
  const item = { id: "00000000-0000-4000-8000-000000000001", title: "Tip calculator", description: "Calculate tips precisely.", revision: 2,
    permission: "admin", updatedAt: new Date().toISOString(), forkedFromId: null, forkedFromRevision: null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
    if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
    if (path.endsWith("/publish")) { publicationNotes.push((await request.json()).note); mutations.push("publish"); publishedRevision = 2; return Response.json({ publishedRevision }); }
    if (path.endsWith("/unpublish")) { publishedRevision = null; return Response.json({ publishedRevision }); }
    if (path.endsWith("/edit-chat")) { mutations.push("edit-chat"); return Response.json({ href: "/edited" }); }
    if (path.endsWith("/restore")) { mutations.push("restore"); publishedRevision = 3; return Response.json({...item, revision:3, publishedRevision:3, publishedVersion:3, sourceRevision:3, source:{entry:"main.js",files:[]}}); }
    if (path.endsWith("/versions")) return Response.json({items:emptyHistory ? [] : [{version:1,revision:1,note:"Initial calculator",createdAt:new Date().toISOString(),authorId:"test"}],page:1,hasNext:false});
    if (path.endsWith("/access")) return Response.json([]);
    if (path.endsWith("/compiled")) { compiledVersions.push(url.searchParams.get("revision")!); return Response.json({ ...compiled, revision: Number(url.searchParams.get("revision")) }); }
    if (path === "/api/assistant/artifacts") { listRequests++; return Response.json({ items: removed ? [] : longCatalog ? Array.from({ length: 30 }, (_, i) => ({ ...item, id: `App${i}`, title: `Catalog app ${i}`, publishedRevision })) : [{ ...item, publishedRevision }], page: 1, hasNext: false }); }
    if (path.startsWith("/api/assistant/artifacts/") && request.method === "DELETE") { removed = true; return Response.json({ ok: true }); }
    if (path.startsWith("/api/assistant/artifacts/")) return Response.json({ ...item, publishedRevision, sourceRevision: url.searchParams.has("version") ? Number(url.searchParams.get("version")) : url.searchParams.has("published") ? publishedRevision : 2, source: { entry: "main.js", files: [] } });
    return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>', { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByText("Published calculator", { exact: true }).waitFor();
    expect(await page.locator(".assistant-studio-card").count()).toBe(0);
    expect(listRequests).toBe(0);
    expect(compiledVersions).toEqual(["1"]);
    longCatalog = true;
    await page.getByRole("button", { name: "Studio", exact: true }).first().click();
    const popup = page.getByRole("dialog", { name: "Studio", exact: true });
    await popup.getByRole("link", { name: "Catalog app 29", exact: true }).waitFor({ state: "attached" });
    const scroll = popup.locator('[data-scroll-fade-mode="both"]');
    await popup.locator('[data-scroll-fade="bottom"]').waitFor();
    expect(await scroll.evaluate(node => getComputedStyle(node).maskImage)).not.toBe("none");
    expect(await popup.getAttribute("data-scroll-fade")).toBeNull();
    expect(await scroll.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await popup.locator('[data-scroll-fade="top"]').waitFor();
    await page.keyboard.press("Escape");
    longCatalog = false;
    await page.getByRole("button", { name: "Studio", exact: true }).first().click();
    await popup.getByRole("link", { name: /Tip calculator/ }).click();
    await page.waitForURL("**/app/assistant/apps/*");
    await page.getByText("Published calculator", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    for (const name of ["Delete", "Edit with Assistant", "Manage access", "Projects", "Update publication", "Unpublish", "Create your own copy", "Secrets", "Edit manually", "SQL console", "Local data", "Shared data", "Manage database"]) {
      expect(await page.getByRole("menuitem", { name, exact: true }).count()).toBe(1);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Manage access", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("dialog").getByText("Manage access · Tip calculator").waitFor();
    expect((await page.getByRole("dialog").boundingBox())!.width).toBeLessThan(900);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Update publication", exact: true }).click();
    await page.getByRole("textbox", {name:"What changed?"}).fill("Improve calculator");
    await page.getByRole("dialog").getByRole("button", {name:"Publish",exact:true}).click();
    await page.getByRole("button", { name: "Actions", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Actions", exact: true }).locator(":scope:not([disabled])").waitFor();
    expect(publishedRevision).toBe(2);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit with Assistant", exact: true }).click();
    await page.waitForURL("**/edited");
    compiledVersions.length = 0;
    await page.goto(new URL("/view", server.url).href);
    await page.getByText("Published calculator", { exact: true }).waitFor();
    expect(compiledVersions).toEqual(["2"]);
    await page.getByRole("button", {name:"Versions",exact:true}).click();
    await page.getByText("Initial calculator",{exact:true}).waitFor();
    await page.getByRole("dialog").getByRole("button",{name:"Start",exact:true}).click();
    await page.getByText("Published calculator",{exact:true}).waitFor();
    expect(compiledVersions).toEqual(["2","1"]);
    expect(publishedRevision).toBe(2);
    expect(await page.getByRole("button", { name: "Publish", exact: true }).count()).toBe(0);
    await page.getByRole("button", {name:"Versions",exact:true}).click();
    await Promise.all([
      page.waitForResponse(response => response.url().includes("/compiled") && response.url().includes("revision=3")),
      page.getByRole("dialog").getByRole("button",{name:"Restore",exact:true}).click(),
    ]);
    await page.getByText("Published calculator",{exact:true}).waitFor();
    expect(publishedRevision).toBe(3);
    expect(compiledVersions).toEqual(["2","1","3"]);
    expect(mutations).toEqual(["publish", "edit-chat", "restore"]);
    emptyHistory = true;
    await page.getByRole("button", {name:"Versions",exact:true}).click();
    await page.getByText("No published versions yet",{exact:true}).waitFor();
    expect(await page.getByRole("dialog").getByRole("button",{name:"Publish",exact:true}).count()).toBe(1);
    expect(await page.getByRole("dialog").getByRole("button",{name:"Start current version",exact:true}).count()).toBe(0);
    await page.keyboard.press("Escape");
    item.description = "";
    await page.goto(new URL("/draft",server.url).href);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Manage access", exact: true }).click();
    await page.getByText("Not published yet", {exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await page.goto(new URL("/draft",server.url).href);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/publish")),
      page.getByRole("menuitem", { name: "Publish", exact: true }).click(),
    ]);
    expect(publicationNotes).toEqual(["Improve calculator", "Initial release"]);
    expect(await page.getByRole("textbox", {name:"What changed?"}).count()).toBe(0);
    await page.getByRole("button", { name: "Actions", exact: true }).locator(":scope:not([disabled])").waitFor();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/unpublish")),
      page.getByRole("menuitem", { name: "Unpublish", exact: true }).click(),
    ]);
    await page.getByRole("button", { name: "Actions", exact: true }).locator(":scope:not([disabled])").waitFor();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    expect(await page.getByRole("menuitem", { name: "Publish", exact: true }).count()).toBe(1);
    expect(await page.getByRole("menuitem", { name: "Unpublish", exact: true }).count()).toBe(0);
    publishedRevision = 2;
    await page.goto(new URL("/reader", server.url).href);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    for (const name of ["Create your own copy", "Secrets", "Local data"]) {
      expect(await page.getByRole("menuitem", { name, exact: true }).count()).toBe(1);
    }
    for (const name of ["Delete", "Manage access", "Edit manually", "SQL console", "Shared data", "Manage database"]) {
      expect(await page.getByRole("menuitem", { name, exact: true }).count()).toBe(0);
    }
    await page.keyboard.press("Escape");
    longCatalog = true;
    await page.goto(new URL("/view?studio=1", server.url).href);
    const catalogDialog = page.getByRole("dialog", { name: "Studio", exact: true });
    await catalogDialog.getByRole("link", { name: "Catalog app 29", exact: true }).waitFor({ state: "attached" });
    expect(new URL(page.url()).searchParams.has("studio")).toBe(false);
    expect(await catalogDialog.getByRole("button", { name: "Search apps", exact: true }).count()).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await catalogDialog.boundingBox())!.width).toBeLessThanOrEqual(390);
    await catalogDialog.locator('[data-scroll-fade="bottom"]').waitFor();
    await catalogDialog.getByRole("button", { name: "Close", exact: true }).click();
    await catalogDialog.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1300, height: 850 });
    longCatalog = false;
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.waitForURL("**/app/assistant*");
    await page.getByRole("dialog", { name: "Studio", exact: true }).getByText("No apps yet. Ask Assistant to build one.", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/app/assistant");
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 120000);
