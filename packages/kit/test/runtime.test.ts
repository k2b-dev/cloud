import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { compile } from "../src/runtime/compile";
import { sandboxDocument } from "../src/runtime/sandbox";

const browserTest = async (content: string) => {
  const source = await compile({ name: "Test", files: [{ path: "test.script.js", content }] }, "test.script.js");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    return await page.evaluate(
      async ({ source, html }) =>
        new Promise<unknown[]>((resolve, reject) => {
          const frame = document.createElement("iframe");
          frame.sandbox.add("allow-scripts");
          frame.srcdoc = html;
          const messages: unknown[] = [];
          const timer = setTimeout(() => reject(new Error("Runtime timed out")), 10000);
          addEventListener("message", (event) => {
            if (event.source !== frame.contentWindow) return;
            if (event.data.type === "bridge-ready") frame.contentWindow!.postMessage({ type: "boot", ...source }, "*");
            else {
              messages.push(event.data);
              if (event.data.type === "ready" || event.data.type === "error") {
                clearTimeout(timer);
                resolve(messages);
              }
            }
          });
          document.body.append(frame);
        }),
      { source, html: sandboxDocument() },
    );
  } finally {
    await browser.close();
  }
};
test("opaque worker denies network and origin storage but executes scripts", async () => {
  const messages = await browserTest(`export default kit.script({name:"Test",async run(){
 let network=false,storage=false,opfs=false;try{await fetch('https://example.com/secret');network=true;}catch{}
 try{await indexedDB.databases();storage=true;}catch{}
 try{await navigator.storage.getDirectory();opfs=true;}catch{}
 console.log(JSON.stringify({network,storage,opfs}));kit.ui.text('Ready');
 }});`);
  expect(JSON.stringify(messages)).toContain('\\"network\\":false');
  expect(JSON.stringify(messages)).toContain('\\"storage\\":false');
  expect(JSON.stringify(messages)).toContain('\\"opfs\\":false');
  expect(JSON.stringify(messages)).toContain("Ready");
}, 20000);

test("local storage shares an app namespace and isolates other apps and users", async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/../src/runtime/storage.ts`],
    target: "browser",
  });
  const code = await bundle.outputs[0]!.text();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost:4179/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html></html>",
      }),
    );
    await page.goto("http://localhost:4179/");
    const result = await page.evaluate(async (code) => {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const { AppStorage } = await import(url);
      URL.revokeObjectURL(url);
      const app = new AppStorage("user-one", "abc123", true),
        secondPage = new AppStorage("user-one", "abc123", true);
      await app.call("opfs.write", ["exports/result.csv", "a;b"]);
      await app.call("store.set", ["history", [{ name: "result.csv" }]]);
      const root = await navigator.storage.getDirectory();
      const dir = await (
        await (await (await root.getDirectoryHandle("kit")).getDirectoryHandle("abc123")).getDirectoryHandle("user-one")
      ).getDirectoryHandle("files");
      const actual = await (await (await dir.getDirectoryHandle("exports")).getFileHandle("result.csv")).getFile();
      let traversal = false,
        disabled = false;
      try {
        await app.call("opfs.write", ["../escape", "bad"]);
      } catch {
        traversal = true;
      }
      try {
        await new AppStorage("user-one", "abc123", false).call("store.get", ["history"]);
      } catch {
        disabled = true;
      }
      const before = {
        text: await actual.text(),
        files: await secondPage.call("opfs.list", []),
        keys: await secondPage.call("store.keys", []),
        otherFiles: await new AppStorage("user-two", "abc123", true).call("opfs.list", []),
        shared: await secondPage.call("store.get", ["history"]),
        otherApp: await new AppStorage("user-one", "xyz789", true).call("store.get", ["history"]),
        otherUser: await new AppStorage("user-two", "abc123", true).call("store.get", ["history"]),
        traversal,
        disabled,
      };
      const other = new AppStorage("user-two", "abc123", true);
      const otherApp = new AppStorage("user-one", "xyz789", true);
      await other.call("opfs.write", ["keep.txt", "other user"]);
      await otherApp.call("store.set", ["keep", "other app"]);
      await app.clear();
      await app.clear();
      return {
        ...before,
        clearedFiles: await app.call("opfs.list", []),
        clearedKeys: await app.call("store.keys", []),
        retainedUser: await (await other.call("opfs.read", ["keep.txt"])).text(),
        retainedApp: await otherApp.call("store.get", ["keep"]),
      };
    }, code);
    expect(result).toEqual({
      clearedFiles: [],
      clearedKeys: [],
      retainedUser: "other user",
      retainedApp: "other app",
      text: "a;b",
      files: ["exports/result.csv"],
      keys: ["history"],
      otherFiles: [],
      shared: [{ name: "result.csv" }],
      otherApp: null,
      otherUser: null,
      traversal: true,
      disabled: true,
    });
  } finally {
    await browser.close();
  }
}, 20000);

test("a busy worker can be stopped and replaced without blocking the browser", async () => {
  const build = (content: string) => compile({ name: "Test", files: [{ path: "test.script.js", content }] }, "test.script.js");
  const first = await build('export default kit.script({name:"Busy",run(){kit.ui.button("Hang",()=>{while(true){}},{id:"hang"});}});');
  const second = await build('export default kit.script({name:"Next",run(){kit.ui.text("Replacement ready");}});');
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(
      async ({ first, second, html }) =>
        new Promise<string>((resolve, reject) => {
          const frame = document.createElement("iframe");
          frame.sandbox.add("allow-scripts");
          frame.srcdoc = html;
          let phase = 0;
          const timer = setTimeout(() => reject(new Error("Stop/restart timed out")), 5000);
          const post = (value: unknown) => frame.contentWindow!.postMessage(value, "*");
          addEventListener("message", (event) => {
            if (event.source !== frame.contentWindow) return;
            const message = event.data;
            if (message.type === "bridge-ready") post({ type: "boot", ...first });
            if (message.type === "ready" && phase === 0) {
              phase = 1;
              post({ type: "event", id: "hang" });
            }
            if (message.type === "busy" && phase === 1) {
              phase = 2;
              post({ type: "stop" });
              post({ type: "boot", ...second });
            }
            if (message.type === "ready" && phase === 2) {
              clearTimeout(timer);
              resolve("restarted");
            }
            if (message.type === "error") {
              clearTimeout(timer);
              reject(new Error(message.text));
            }
          });
          document.body.append(frame);
        }),
      { first, second, html: sandboxDocument() },
    );
    expect(result).toBe("restarted");
  } finally {
    await browser.close();
  }
}, 15000);

test("money namespace computes exact amounts inside the isolated worker", async () => {
  const messages = await browserTest(`export default kit.script({name:"Money",run(){
    const m = kit.money;
    const net = m.parse('1.234,56', { locale: 'de-DE', currency: 'EUR' });
    const total = m.taxFromNet(net, { percent: '19', rounding: 'half-up' });
    const shares = m.allocate(total.gross, [1, 1, 1]);
    if (net.amount !== 123456 || total.gross.amount !== 146913) throw Error('Tax mismatch');
    if (m.compare(m.sum(shares), total.gross) !== 0) throw Error('Allocation mismatch');
    if (m.toDecimal(total.gross) !== '1469.13') throw Error('CSV mismatch');
    if (!m.format(total.gross, {locale:'de-DE'}).includes('1.469,13')) throw Error('Format mismatch');
    let rejected = false;
    try { m.add(net, m.fromMinor(1, 'USD')); } catch { rejected = true; }
    if (!rejected) throw Error('Mixed currency accepted');
    kit.ui.text('Money verified');
  }});`);
  expect(
    messages.filter((message) => typeof message === "object" && message !== null && "type" in message && message.type === "error"),
  ).toEqual([]);
  expect(JSON.stringify(messages)).toContain("Money verified");
}, 20000);
