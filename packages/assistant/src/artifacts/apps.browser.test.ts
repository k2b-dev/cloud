import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { compileArtifact } from "./runtime/compile";

test("Studio tile menus publish and edit; launch opens the runner directly", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./apps-browser-harness.tsx"], { stdout: "pipe", stderr: "pipe" });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: 'export default () => { ui.text({value:"Published calculator"}); };' }] });
  let publishedRevision = 1;
  let emptyHistory = false;
  let listRequests = 0;
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
    if (path.endsWith("/edit-chat")) { mutations.push("edit-chat"); return Response.json({ href: "/edited" }); }
    if (path.endsWith("/restore")) { mutations.push("restore"); publishedRevision = 3; return Response.json({...item, revision:3, publishedRevision:3, publishedVersion:3, sourceRevision:3, source:{entry:"main.js",files:[]}}); }
    if (path.endsWith("/versions")) return Response.json({items:emptyHistory ? [] : [{version:1,revision:1,note:"Initial calculator",createdAt:new Date().toISOString(),authorId:"test"}],page:1,hasNext:false});
    if (path.endsWith("/access")) return Response.json([]);
    if (path.endsWith("/compiled")) { compiledVersions.push(url.searchParams.get("revision")!); return Response.json({ ...compiled, revision: Number(url.searchParams.get("revision")) }); }
    if (path === "/api/assistant/artifacts") { listRequests++; return Response.json({ items: [{ ...item, publishedRevision }], page: 1, hasNext: false }); }
    if (path.startsWith("/api/assistant/artifacts/")) return Response.json({ ...item, publishedRevision, sourceRevision: url.searchParams.has("version") ? Number(url.searchParams.get("version")) : url.searchParams.has("published") ? publishedRevision : 2, source: { entry: "main.js", files: [] } });
    return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>', { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByText("Calculate tips precisely.").waitFor();
    expect(await page.locator(".assistant-apps-grid").count()).toBe(1);
    const icon = await page.locator(".assistant-studio-card__icon").boundingBox();
    const title = await page.locator(".assistant-studio-card__title").boundingBox();
    expect(title!.x).toBeGreaterThan(icon!.x + icon!.width);
    expect(listRequests).toBe(0);
    expect(compiledVersions).toEqual([]);
    await page.getByRole("button", { name: "Actions · Tip calculator", exact: true }).click();
    await page.getByRole("menuitem", { name: "Manage access", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("dialog").getByText("Manage access · Tip calculator").waitFor();
    expect((await page.getByRole("dialog").boundingBox())!.width).toBeLessThan(900);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Actions · Tip calculator", exact: true }).click();
    await page.getByRole("menuitem", { name: "Update publication", exact: true }).click();
    await page.getByRole("textbox", {name:"What changed?"}).fill("Improve calculator");
    await page.getByRole("dialog").getByRole("button", {name:"Publish",exact:true}).click();
    await page.getByRole("button", { name: "Start", exact: true }).waitFor();
    expect(publishedRevision).toBe(2);
    expect(compiledVersions).toEqual([]);
    await page.getByRole("button", { name: "Actions · Tip calculator", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit with Assistant", exact: true }).click();
    await page.waitForURL("**/edited");
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
    await page.locator(".assistant-studio-card__top--title-only").waitFor();
    const centeredIcon = (await page.locator(".assistant-studio-card__icon").boundingBox())!;
    const centeredTitle = (await page.locator(".assistant-studio-card__title").boundingBox())!;
    expect(Math.abs(centeredIcon.y + centeredIcon.height / 2 - centeredTitle.y - centeredTitle.height / 2)).toBeLessThan(1);
    await page.getByRole("button", { name: "Actions · Tip calculator", exact: true }).click();
    await page.getByRole("menuitem", { name: "Manage access", exact: true }).click();
    await page.getByText("Not published yet", {exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await page.goto(new URL("/draft",server.url).href);
    await page.getByRole("button", { name: "Actions · Tip calculator", exact: true }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/publish")),
      page.getByRole("menuitem", { name: "Publish", exact: true }).click(),
    ]);
    expect(publicationNotes).toEqual(["Improve calculator", "Initial release"]);
    expect(await page.getByRole("textbox", {name:"What changed?"}).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 60000);
