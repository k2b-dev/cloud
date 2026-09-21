import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { AnalyticsNode } from "./runtime/analytics-contracts";
import { compileArtifact } from "./runtime/compile";

test("chat preview survives reload without execution; controls run on demand and exports are static", async () => {
  const build = Bun.spawn(
    ["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./chat-presentation-browser-harness.tsx"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [bundle, buildError] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(buildError);
  const code = `export default () => {
    const total = ui.stat({id:"total",label:"Total",value:20});
    ui.row({id:"metrics",children:[total,ui.stat({id:"available",label:"Available",value:21}),ui.stat({id:"maintenance",label:"Maintenance",value:4}),ui.stat({id:"value",label:"Value",value:21960})]});
    ui.slider({id:"quantity",label:"Quantity",min:1,max:20,value:2,onChange:value=>total.setValue(value*10)});
    ui.button({id:"reset",label:"Reset",onClick:()=>total.setValue(20)});
  }`;
  const source = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
  const nodes = [
    { id: "total", type: "stat", label: "Total", value: 20 },
    { id: "available", type: "stat", label: "Available", value: 21 },
    { id: "maintenance", type: "stat", label: "Maintenance", value: 4 },
    { id: "value", type: "stat", label: "Value", value: 21960 },
    { id: "metrics", type: "layout", layout: "row", children: ["total", "available", "maintenance", "value"] },
    { id: "reset", type: "button", label: "Reset" },
    { id: "quantity", type: "slider", label: "Quantity", min: 1, max: 20, value: 2 },
  ].map((node) => AnalyticsNode.parse(node));
  let starts = 0,
    pdfHtml = "",
    staticView = false;
  let releasePresentation: (() => void) | undefined;
  const presentationReady = new Promise<void>((resolve) => {
    releasePresentation = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
      if (path === "/api/assistant/artifacts/runtime/compile") {
        starts++;
        return Response.json(source);
      }
      if (path === "/api/assistant/artifacts/runtime/pdf") {
        const form = await req.formData();
        pdfHtml = JSON.parse(String(form.get("request"))).html;
        return new Response("%PDF-1.4\nfixture", { headers: { "Content-Type": "application/pdf" } });
      }
      if (path.startsWith("/api/assistant/artifacts/presentations/")) {
        await presentationReady;
        return Response.json({
          id: "00000000-0000-4000-8000-000000000001",
          conversationId: "abc234",
          title: "Inventory",
          code,
          nodes: staticView ? nodes.filter((node) => node.type !== "button" && node.type !== "slider") : nodes,
          inputs: [],
        });
      }
      return new Response(
        '<!doctype html><html lang="de"><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.locator(".assistant-chat-presentation").waitFor();
    const loadingHeight = (await page.locator(".assistant-chat-presentation").boundingBox())!.height;
    expect(loadingHeight).toBe(360);
    releasePresentation?.();
    await page.getByRole("button", { name: "Interagieren", exact: true }).waitFor();
    expect((await page.locator(".assistant-chat-presentation").boundingBox())!.height).toBe(loadingHeight);
    await page.setViewportSize({ width: 900, height: 400 });
    const header = page.locator(".assistant-chat-presentation__body > header");
    const headerTop = (await header.boundingBox())!.y;
    await page.locator(".assistant-chat-presentation__body").evaluate((el) => {
      el.scrollTop = 80;
    });
    expect((await header.boundingBox())!.y).toBeLessThan(headerTop);
    await page.locator(".assistant-chat-presentation__body").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.setViewportSize({ width: 900, height: 1800 });
    expect((await page.locator(".assistant-chat-presentation").boundingBox())!.height).toBe(600);
    await page.setViewportSize({ width: 900, height: 800 });
    expect(starts).toBe(0);
    expect(await page.locator("iframe").count()).toBe(0);
    expect(await page.locator('[data-artifact-id="total"]').textContent()).toContain("Total");
    expect(await page.getByRole("button", { name: "Reset", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole("slider").isDisabled()).toBe(true);
    const previewMetric = await page.locator('[data-artifact-id="total"]').boundingBox();
    const previewStyles = await page
      .locator('[data-artifact-id="total"]')
      .evaluate((el) => ({ font: getComputedStyle(el).fontSize, color: getComputedStyle(el).color }));
    await page.reload();
    await page.getByRole("button", { name: "Interagieren", exact: true }).waitFor();
    expect(starts).toBe(0);
    await page.getByRole("button", { name: "Interagieren", exact: true }).click();
    await page.locator('[data-artifact-id="reset"] button:not([disabled])').waitFor();
    expect(starts).toBe(1);
    expect(await page.locator('[data-artifact-id="total"]').boundingBox()).toEqual(previewMetric);
    expect(
      await page
        .locator('[data-artifact-id="total"]')
        .evaluate((el) => ({ font: getComputedStyle(el).fontSize, color: getComputedStyle(el).color })),
    ).toEqual(previewStyles);
    await page.getByRole("slider").focus();
    await page.getByRole("slider").press("ArrowRight");
    await page.waitForFunction(() => document.querySelector('[data-artifact-id="total"]')?.textContent?.includes("30"));
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("menuitem", { name: "HTML", exact: true }).click();
    const download = await downloaded;
    const exported = await Bun.file((await download.path())!).text();
    expect(exported).toContain("30");
    expect(exported).not.toContain("<button");
    expect(exported).not.toContain("<input");
    const pdfDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("menuitem", { name: "PDF", exact: true }).click();
    expect((await pdfDownload).suggestedFilename()).toBe("Inventory.pdf");
    expect(pdfHtml).toContain("30");
    expect(pdfHtml).not.toContain("<input");
    expect(pdfHtml).not.toContain("<button");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-artifact-id="total"]')?.textContent?.includes("20"));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: "/tmp/assistant-chat-presentation.png", fullPage: true });
    await page.getByRole("button", { name: "Stoppen", exact: true }).click();
    expect(await page.locator('iframe[title="Isolated artifact runtime"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "Reset", exact: true }).isDisabled()).toBe(true);
    expect(await page.locator('[data-artifact-id="total"]').textContent()).toContain("20");
    await page.getByRole("button", { name: "Interagieren", exact: true }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).waitFor();
    await page.getByRole("button", { name: "Leave chat", exact: true }).click();
    expect(await page.locator("iframe").count()).toBe(0);
    staticView = true;
    const beforeStatic = starts;
    await page.reload();
    await page.getByRole("button", { name: "Downloads", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Interagieren", exact: true }).count()).toBe(0);
    expect(await page.locator("iframe").count()).toBe(0);
    expect(await page.locator(".assistant-chat-presentation > footer").count()).toBe(0);
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    const staticDownload = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "HTML", exact: true }).click();
    expect(await Bun.file((await (await staticDownload).path())!).text()).toContain("21960");
    expect(starts).toBe(beforeStatic);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
