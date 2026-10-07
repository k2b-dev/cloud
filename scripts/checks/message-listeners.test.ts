import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rule } from "./message-listeners";

const lines = async (source: string) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-message-listeners-"));
  try {
    const path = join(root, "packages/demo/src/frame.ts");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map((finding) => finding.line);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports window message listeners that act without checking event.source", async () => {
  expect(
    await lines(
      [
        'addEventListener("message", (event) => run(event.data));',
        'window.addEventListener("message", onMessage);',
        "function onMessage(event: MessageEvent) {",
        "  run(event.data);",
        "}",
        "window.onmessage = (event) => { run(event.data); };",
        'globalThis.addEventListener("message", async (event) => { await run(event.data); });',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 6, 7]);
});

test("accepts listeners that compare event.source, also inside embedded frame scripts", async () => {
  expect(
    await lines(
      [
        'window.addEventListener("message", receive);',
        "const receive = (event: MessageEvent) => {",
        "  if (event.source !== frame.contentWindow) return;",
        "};",
        'addEventListener("message", (event) => { if (event.source !== parent) return; run(event.data); });',
        "const page = `<script>addEventListener('message',e=>{if(e.source!==parent)return;go(e.data)})</script>`;",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("ignores sockets, ports, channels and service workers, which only hear their own peer", async () => {
  expect(
    await lines(
      [
        'socket.addEventListener("message", (event) => run(event.data));',
        'upstreamSocket.addEventListener("message", (event) => run(event.data));',
        'navigator.serviceWorker?.addEventListener("message", opened);',
        "port.onmessage = (event) => run(event.data);",
      ].join("\n"),
    ),
  ).toEqual([]);
});
