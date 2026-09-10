import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { compile } from "../src/runtime/compile";
import type { UiNode } from "../src/runtime/protocol";

test("host accepts refreshed list ownership and rejects unowned actions", async () => {
  const build = Bun.spawn([process.execPath, "build", `${import.meta.dir}/../src/runtime/host.ts`, "--target=browser"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const host = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const source = await compile(
    {
      name: "List",
      files: [
        {
          path: "main.script.js",
          content: `export default kit.script({name:'List', run(){
    const action = kit.ui.button('Done', () => {}, {id:'done'});
    const list = kit.ui.list({title:'Tasks',id:'tasks'}, [{id:'one',title:'One',action}]);
    list.set([]);
    kit.ui.button('Ask', async () => { await kit.ui.modal.number({title:'Count',label:'Count'}); }, {id:'ask'});
    kit.ui.button('Restore', () => list.set([{id:'two',title:'Two',action}]), {id:'restore'});
  }});`,
        },
      ],
    },
    "main.script.js",
  );
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost:4179/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
    );
    await page.goto("http://localhost:4179/");
    const result = await page.evaluate(
      async ({ host, source }) => {
        const url = URL.createObjectURL(new Blob([host], { type: "text/javascript" }));
        const { startRun } = await import(url);
        URL.revokeObjectURL(url);
        let nodes: UiNode[] = [],
          error = "",
          ready = false,
          modalKind = "",
          aborted = false;
        const run = startRun(
          document.body,
          source,
          {},
          {
            ui: (value: UiNode[]) => {
              nodes = value;
            },
            modal: (request: { kind: string }, signal: AbortSignal) =>
              new Promise((resolve) => {
                modalKind = request.kind;
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    resolve(null);
                  },
                  { once: true },
                );
              }),
            log() {},
            error: (value: string) => {
              error = value;
            },
            busy() {},
            ready() {
              ready = true;
            },
            pick: async () => [],
            save: async () => {},
          },
        );
        const wait = async (condition: () => boolean) => {
          const deadline = Date.now() + 7000;
          while (!condition()) {
            if (error) throw new Error(error);
            if (Date.now() > deadline) throw new Error("List update timed out");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        try {
          await wait(() => ready);
          const empty = nodes.find((n) => n.id === "tasks")!;
          run.event("restore");
          await wait(() => nodes.some((n) => n.id === "tasks" && n.items.length === 1));
          const restored = nodes.find((n) => n.id === "tasks")!;
          run.event("ask");
          await wait(() => modalKind === "number");
          // Exercise the host's validation using an invalid worker snapshot.
          const frame = document.querySelector("iframe")!;
          window.dispatchEvent(
            new MessageEvent("message", {
              source: frame.contentWindow,
              data: { type: "ui", nodes: nodes.map((n) => (n.id === "tasks" ? { ...n, children: [] } : n)) },
            }),
          );
          await wait(() => !!error);
          return { empty: empty.items.length, owned: empty.children, restored: restored.items[0]!.title, error, aborted };
        } finally {
          await run.stop();
        }
      },
      { host, source },
    );
    expect(result).toEqual({ empty: 0, owned: ["done"], restored: "Two", error: "Invalid layout references", aborted: true });
  } finally {
    await browser.close();
  }
}, 20000);
