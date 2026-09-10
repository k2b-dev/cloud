import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { sdkReference } from "../src/sdk";
import { compile } from "../src/runtime/compile";
import { sandboxDocument } from "../src/runtime/sandbox";
import { WorkerMessage } from "../src/runtime/protocol";

test("local documentation examples execute in the actual isolated worker", async () => {
  const examples = Object.entries(sdkReference.details).filter(
    ([name]) => name.startsWith("ui.") || name.startsWith("money.") || name.startsWith("sheet."),
  );
  const content = `export default kit.script({name:"Reference",async run(){${examples.map(([, d]) => `{${d.example}\n}`).join("\n")}\n${sdkReference.chartExamples.map((c) => `kit.ui.chart(${JSON.stringify(c)});`).join("\n")}\nconsole.log("REFERENCE_OK");}});`;
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
            else {
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
    expect(JSON.stringify(messages)).toContain("REFERENCE_OK");
    await page.close();
  } finally {
    await browser.close();
  }
}, 30000);
