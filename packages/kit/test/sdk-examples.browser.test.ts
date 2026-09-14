import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { sdkReference } from "../src/sdk";
import { compile } from "../src/runtime/compile";
import { sandboxDocument } from "../src/runtime/sandbox";
import { WorkerMessage } from "../src/runtime/protocol";

test.each([false, true])("documentation executes in the isolated worker (CRUD: %s)", async (crud) => {
  const examples = Object.entries(sdkReference.details).filter(
    ([name]) => name.startsWith("ui.") || name.startsWith("money.") || name.startsWith("sheet."),
  );
  const content = crud ? await Bun.file(new URL("../src/help/examples/crud.script.js", import.meta.url)).text() : `export default kit.script({name:"Reference",async run(){${examples.map(([, d]) => `{${d.example}\n}`).join("\n")}\n${sdkReference.chartExamples.map((c) => `kit.ui.chart(${JSON.stringify(c)});`).join("\n")}\nconsole.log("REFERENCE_OK");}});`;
  const source = await compile({ name: "Reference", files: [{ path: "main.script.js", content }] }, "main.script.js");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(
      ({ source, html }) =>
        new Promise<unknown[]>((resolve, reject) => {
          const frame = document.createElement("iframe");
          frame.sandbox.add("allow-scripts");
          frame.srcdoc = html;
          const messages: unknown[] = [];
          const end = () => {
            clearTimeout(timer);
            frame.contentWindow?.postMessage({ type: "stop" }, "*");
            setTimeout(() => {
              frame.remove();
              resolve(messages);
            }, 0);
          };
          const timer = setTimeout(() => {
            frame.remove();
            reject(Error("Example worker timed out"));
          }, 10000);
          window.addEventListener("message", (event) => {
            if (event.source !== frame.contentWindow) return;
            if (event.data.type === "bridge-ready") frame.contentWindow!.postMessage({ type: "boot", ...source }, "*");
            else if (event.data.type === "rpc" && event.data.method === "db.call") {
              frame.contentWindow!.postMessage({ type: "result", id: event.data.id, value: { data: [] } }, "*");
            } else {
              messages.push(event.data);
              if (event.data.type === "ready" || event.data.type === "error") end();
            }
          });
          document.body.append(frame);
        }),
      { source, html: sandboxDocument() },
    );
    const messages = result.map((m) => WorkerMessage.parse(m));
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(JSON.stringify(messages)).toContain(crud ? "No matching tasks" : "REFERENCE_OK");
    if (crud) {
      const snapshots = messages.filter(m => m.type === "ui");
      expect(JSON.stringify(snapshots)).not.toContain('"label":"Delete"');
    }
    await page.close();
  } finally {
    await browser.close();
  }
}, 60000);
