import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { renameSource } from "./rename-source";
import { compileArtifact } from "./runtime/compile";

test("Studio editor keeps pending edits and file sessions; SQL and local data are reachable without replacing navigation", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./advanced-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
      return new Response(
        '<!doctype html><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="height:100vh"><div id="root" style="height:100%"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    let revision = 1, publishedRevision = 1, compileCalls = 0;
    let hasTables = true;
    const saves: (()=>void)[]=[];
    async function finishSave(){
      const until=Date.now()+5000;
      while(!saves.length&&Date.now()<until)await Bun.sleep(10);
      const resolve=saves.shift();if(!resolve)throw new Error("Save request was not sent");resolve();
    }
    let source = {
      entry: "main.ts",
      files: [
        { path: "main.ts", content: 'export default () => { ui.text({value:"Hello"}); };' },
        { path: "other.ts", content: "export const amount = 10;" },
      ],
    };
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      let data: unknown = {};
      if (path.endsWith("/runtime/rename")) {
        const input = request.postDataJSON();
        data = renameSource(input.source, input.from, input.to);
      } else if (path.endsWith("/compiled")) {
        compileCalls++;
        data = { ...(await compileArtifact(source)), revision };
      } else if (path.endsWith("/versions")) data = { items: [] };
      else if (path.endsWith("/publish")) {
        expect(request.postDataJSON().expectedRevision).toBe(revision);
        publishedRevision = revision;
      } else if (path.endsWith("/database/status")) data = { configured: true, connected: true, overview: null, unavailable: null };
      else if (path.endsWith("/database/inspect")) {
        const input = request.postDataJSON();
        data =
          input.operation === "tables.list"
            ? (hasTables ? [{ name: "ledger" }] : [])
            : input.operation === "schema.get"
              ? { columns: [{ name: "amount", type: "integer" }] }
              : { data: [{ amount: 1250 }] };
      } else if (request.method() === "PUT") {
        source = request.postDataJSON().source;
        revision++;
        await new Promise<void>((resolve) => {
          saves.push(resolve);
        });
        data = {
          id: "00000000-0000-4000-8000-000000000001",
          title: "Advanced fixture",
          kind: "app",
          permission: "admin",
          revision,
          publishedRevision,
          sourceRevision: revision,
          source,
        };
      } else if (path.endsWith("/artifacts")) data = { items: [], page: 1, hasNext: false };
      else
        data = {
          id: "00000000-0000-4000-8000-000000000001",
          title: "Advanced fixture",
          kind: "app",
          permission: "admin",
          revision,
          publishedRevision,
          sourceRevision: revision,
          source,
        };
      await route.fulfill({ json: data });
    });
    await page.goto(server.url + "app/assistant/apps/00000000-0000-4000-8000-000000000001/edit");
    expect(await page.locator(".k2b-split-button__primary").evaluate(el => ({
      top: getComputedStyle(el).borderTopRightRadius,
      bottom: getComputedStyle(el).borderBottomRightRadius,
    }))).toEqual({top:"0px",bottom:"0px"});
    const editor = page.getByRole("textbox", { name: "main.ts", exact: true });
    expect(await page.getByRole("button", {name:"Publish", exact:true}).isDisabled()).toBe(true);
    await editor.fill('export default () => { ui.text({value:"Changed"}); ui.button({label:"Pick", onClick: async () => { const file = await files.open(); if(file) ui.text({value:file.name}); }}); ui.button({label:"Ask", onClick: async () => { setTimeout(() => console.info("Waiting"), 30); if(await ui.modal.confirm({title:"Test dialog",message:"Continue?"})) await files.save("ok", "result.txt"); }}); };');
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') !== null);
    await editor.fill('export default () => { ui.text({value:"Typed while saving"}); };');
    await finishSave();
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    expect(await editor.inputValue()).toContain("Typed while saving");
    expect(compileCalls).toBe(0);
    await page.getByRole("button", { name: "File path" }).click();
    await page.getByRole("menuitem", { name: "other.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "other.ts", exact: true }).fill("export const amount = 20;");
    await page.getByRole("button", { name: "File path" }).click();
    await page.getByRole("menuitem", { name: "main.ts", exact: true }).click();
    expect(await editor.inputValue()).toContain("Typed while saving");
    await editor.press("Control+z");
    expect(await editor.inputValue()).toContain("Changed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await finishSave();
    await page.getByRole("button", {name:"Publish",exact:true}).click();
    await page.waitForFunction(() => { const b = Array.from(document.querySelectorAll("button")).find(b=>b.textContent?.trim()==="Publish"); return b?.disabled && b.getAttribute("aria-busy") !== "true"; });
    expect(publishedRevision).toBe(revision);
    expect(compileCalls).toBe(0);
    await page.getByRole("button", {name:"Start",exact:true}).click();
    await page.getByText("Changed", { exact: true }).waitFor();
    expect(compileCalls).toBe(1);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", {name:"Pick",exact:true}).click();
    await (await chooser).setFiles({name:"local-example.csv",mimeType:"text/csv",buffer:Buffer.from("a;b\n1;2")});
    await page.getByText("local-example.csv", {exact:true}).waitFor();
    await page.getByRole("button",{name:"Ask",exact:true}).click();
    await page.getByText("Continue?",{exact:true}).waitFor();
    const download = page.waitForEvent("download");
    await page.getByRole("button",{name:"Confirm",exact:true}).click();
    expect((await download).suggestedFilename()).toBe("result.txt");
    await page.screenshot({path:"/tmp/assistant-advanced-editor.png"});
    await page.setViewportSize({width:800,height:900});
    await page.getByRole("tab",{name:"Code",exact:true}).click();
    expect(await editor.isVisible()).toBe(true);
    expect(await page.getByText("Changed",{exact:true}).isVisible()).toBe(false);
    await page.getByRole("tab",{name:"Execution",exact:true}).click();
    expect(await page.getByText("Changed",{exact:true}).isVisible()).toBe(true);
    await page.setViewportSize({width:1400,height:900});
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(server.url + "app/assistant/apps/00000000-0000-4000-8000-000000000001/database");
    await page.getByRole("textbox", { name: "query.sql" }).fill("SELECT amount FROM ledger LIMIT 100");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByText("1250", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "CSV", exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole("tab", {name:"Table", exact:true}).count()).toBe(0);
    expect(await page.getByRole("button", {name:"Table", exact:true}).count()).toBe(0);
    await page.getByRole("tab", {name:"Schema", exact:true}).click();
    await page.getByText("integer", {exact:true}).waitFor();
    await page.screenshot({path:"/tmp/assistant-sql-simplified.png"});
    hasTables = false;
    await page.getByRole("button", {name:"Refresh", exact:true}).click();
    await page.getByText("This database has no tables yet.", {exact:true}).waitFor();
    await page.getByRole("tab", {name:"SQL", exact:true}).click();
    expect(await page.getByRole("textbox", {name:"query.sql"}).inputValue()).toBe("SELECT amount FROM ledger LIMIT 100");
    await page.goto(server.url + "gallery?reader");
    await page.getByRole("button", { name: "Actions · Advanced fixture" }).click();
    expect(await page.getByRole("menuitem", { name: "Edit manually" }).count()).toBe(0);
    await page.getByRole("menuitem", { name: "Local data", exact: true }).click();
    await page.getByRole("tab", { name: "Key/value data", exact: true }).click();
    await page.getByText("local-fixture", { exact: true }).waitFor();
    expect(await page.getByText("private-fixture", { exact: true }).count()).toBe(0);
    await page.getByRole("button",{name:"Delete all my local files and KV",exact:true}).click();
    await page.getByRole("button",{name:"Confirm",exact:true}).click();
    await page.getByText("No entries",{exact:true}).waitFor();
    const privateRemains=await page.evaluate(async()=>{
      const root=await navigator.storage.getDirectory();
      const resources=await root.getDirectoryHandle("assistant-artifacts");
      const resource=await resources.getDirectoryHandle("00000000-0000-4000-8000-000000000001");
      const user=await resource.getDirectoryHandle("someone-else");
      return (await (await (await user.getDirectoryHandle("kv")).getFileHandle("private-fixture")).getFile()).text();
    });
    expect(privateRemains).toBe("99");
    await page.goto(server.url + "starters");
    await page.locator(".assistant-starter").first().waitFor();
    expect(await page.locator(".assistant-starter").count()).toBe(4);
    await page.screenshot({path:"/tmp/assistant-starters-live.png"});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
