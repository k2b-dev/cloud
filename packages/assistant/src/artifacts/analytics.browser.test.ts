import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { compileArtifact } from "./runtime/compile";

test("opaque worker drives ChartExplorer, controls, tables and responsive layouts", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./analytics-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bundle, error] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(error);
  const source = await compileArtifact({
    entry: "main.ts",
    files: [
      {
        path: "main.ts",
        content: `

    export default () => {
      const stat = ui.stat({id:"stat",label:"Revenue KPI",value:123.456,format:{type:"currency",currency:"EUR",maximumFractionDigits:2}});
      const result = ui.text({ id: "result", value: "No selection" });
      const view = ui.chartExplorer({id:"revenue", label:"Revenue", columns:[{key:"name",label:"Region"},{key:"value",label:"Revenue",format:{type:"currency",currency:"EUR"},sortable:true}],
        data:{rowKey:"id",rows:[{id:"a",name:"North",value:12},{id:"b",name:"South",value:8}],chart:{kind:"bar",category:"name",value:"value"},context:{mode:"snapshot",asOf:"2026-09-13T12:00:00Z",sources:[{label:"Fixture"}],status:"fixture",note:"Demonstration only"}},
        onSelect(row){result.setValue(row ? row.name : "No selection");}});
      const scale = ui.number({id:"scale",label:"Scale",value:1,min:0,max:10,onChange(value){result.setValue("Scale: "+value);}});
      const choice = ui.select({id:"choice",label:"Window",value:"all",options:[{value:"all",label:"All"},{value:"recent",label:"Recent"}],onChange(value){result.setValue(value);}});
      const columns = [{key:"value",label:"Count",sortable:true}];
      const data = value => ({rowKey:"id",rows:[{id:"a",name:"A",value}],chart:{kind:"bar",category:"name",value:"value"}});
      const group = ui.explorer({id:"group",label:"Linked charts",snapshot:{request:{step:"first"},charts:{one:data(1),two:data(2)}},steps:[{key:"first",label:"First"},{key:"second",label:"Second"}],async load(request){return {request,charts:{one:data(3),two:data(6)}};}});
      const one = group.chart("one",{label:"First chart",columns}); const two = group.chart("two",{label:"Second chart",columns});
      ui.column({children:[stat,result,scale,choice,group,ui.grid({children:[view,one,two]})]});
    }
  `,
      },
    ],
  });
  const css = await Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)).text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/source") return Response.json(source);
      if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent === "ready");
    expect(await page.locator(".k2b-chart-explorer").count()).toBe(3);
    expect(await page.locator(".k2b-stat-cell").textContent()).toContain("€123.46");
    expect(
      await page.evaluate(() =>
        Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith("/ui.css") && sheet.cssRules.length > 0),
      ),
    ).toBe(true);
    expect(await page.getByText("Demonstration only", { exact: true }).count()).toBe(1);
    const explorer = page.locator('[data-artifact-id="revenue"]');
    await explorer.getByRole("button", { name: "Chart view", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Table", exact: true }).click();
    await explorer.getByRole("button", { name: "North", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-artifact-id="result"]')?.textContent?.trim() === "North");
    expect(await explorer.textContent()).toContain("€12.00");
    await page.getByLabel("Scale", { exact: true }).fill("2");
    await page.getByLabel("Scale", { exact: true }).press("Tab");
    await page.waitForFunction(() => document.querySelector('[data-artifact-id="result"]')?.textContent?.trim() === "Scale: 2");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('[data-artifact-id="node-0"] [data-chart-datum]')?.getAttribute("data-chart-datum")?.includes('"value":3'),
    );
    expect(await page.locator("#errors").textContent()).toBe("");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: "/tmp/assistant-analytics-mobile.png", fullPage: true });
    expect(await page.locator("#errors").textContent()).toBe("");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
