import { test, expect } from "bun:test";
import { chromium } from "playwright";
import type { UiNode } from "../src/runtime/protocol";
import { compile } from "../src/runtime/compile";
import { starter } from "../src/starter";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CSV starter exports renamed string columns and shares results with its history page", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "kit-host-"));
  const hostPath = join(temporary, "host.js");
  const build = Bun.spawn(
    [process.execPath, "build", `${import.meta.dir}/../src/runtime/host.ts`, "--target=browser", `--outfile=${hostPath}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  const host = await readFile(hostPath, "utf8");
  await rm(temporary, { recursive: true, force: true });
  const storageBuild = await Bun.build({
    entrypoints: [`${import.meta.dir}/../src/runtime/storage.ts`],
    target: "browser",
  });
  const convert = await compile(starter, "convert.script.js"),
    history = await compile(starter, "history.script.js");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost:4179/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("http://localhost:4179/");
    const result = await page.evaluate(
      async ({ convert, history, host, storage }) => {
        const load = async (code: string) => {
          const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          try {
            return await import(url);
          } finally {
            URL.revokeObjectURL(url);
          }
        };
        const { startRun } = await load(host),
          { AppStorage } = await load(storage);
        let pickerAccept: string | undefined;
        let currentNodes: UiNode[] = [],
          failure: string | undefined,
          download: string | undefined,
          ready = false,
          busy = false;
        const wait = async (predicate: () => boolean) => {
          const deadline = Date.now() + 7000;
          while (!predicate()) {
            if (failure) throw new Error(failure);
            if (Date.now() > deadline) throw new Error("Runtime transition timed out");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        const hooks = {
          ui: (nodes: UiNode[]) => {
            currentNodes = nodes;
          },
          log: () => {},
          error: (message: string) => {
            failure = message;
          },
          busy: (value: boolean) => {
            busy = value;
          },
          ready: () => {
            ready = true;
          },
          pick: async (_multiple: boolean, _folder: boolean, accept?: string) => {
            pickerAccept = accept;
            return [new File(["reference;amount\n00123;12,34\n00456;0,01\n"], "original.csv")];
          },
          save: async (data: Blob | string) => {
            download = typeof data === "string" ? data : await data.text();
          },
        };
        const appStorage = new AppStorage("test-user", "abc123", true);
        await appStorage.call("opfs.write", ["older.csv", "old;result"]);
        await appStorage.call("store.set", ["history", [{ filename: "older.csv", rows: 3 }]]);
        let run = startRun(document.body, convert, appStorage, hooks);
        await wait(() => ready);
        run.event("open");
        await wait(() => currentNodes.some((n) => n.label === "2 Zeilen geladen"));
        const preview = currentNodes.find((n) => n.id === "preview");
        run.event("columns", "missing:Beleg");
        await wait(() => currentNodes.some((n) => n.id === "preview" && n.state === "error"));
        const invalidExportDisabled = currentNodes.find((n) => n.id === "export")?.disabled;
        run.event("columns", "reference:Beleg,amount:Betrag");
        await wait(() => currentNodes.some((n) => n.id === "preview" && n.columns[0]?.label === "Beleg"));
        await wait(() => !busy);
        run.event("export");
        await wait(() => download !== undefined && !busy);
        run.stop();
        ready = false;
        currentNodes = [];
        run = startRun(document.body, history, appStorage, hooks);
        await wait(() => ready);
        const labels = currentNodes.map((n) => n.label);
        const items = currentNodes.find((n) => n.id === "exports")?.items ?? [];
        const exported = download;
        download = undefined;
        run.event(items.find((item) => item.id === "older.csv")!.action!);
        await wait(() => download !== undefined && !busy);
        run.stop();
        const historicalDownload = download;
        download = undefined;
        ready = false;
        currentNodes = [];
        run = startRun(document.body, convert, new AppStorage("test-user", "abc123", false), hooks);
        await wait(() => ready);
        run.event("open");
        await wait(() => currentNodes.some((n) => n.label === "2 Zeilen geladen") && !busy);
        run.event("export");
        await wait(() => download !== undefined && !busy);
        const storageDisabledStatus = currentNodes.find((n) => n.kind === "status")?.label;
        run.stop();
        return {
          download: exported,
          historicalDownload,
          storageDisabledDownload: download,
          storageDisabledStatus,
          preview,
          invalidExportDisabled,
          items,
          labels,
          pickerAccept,
          files: await appStorage.call("opfs.list", []),
        };
      },
      {
        convert,
        history,
        host,
        storage: await storageBuild.outputs[0]!.text(),
      },
    );
    expect(result.pickerAccept).toBe(".csv,text/csv");
    expect(result.download).toBe("\uFEFFBeleg;Betrag\r\n00123;12,34\r\n00456;0,01");
    expect(result.labels).toContain("Exporte auf diesem Gerät: 2");
    expect(result.files).toHaveLength(2);
    expect(result.preview?.columns.map((c) => c.label)).toEqual(["reference", "amount"]);
    expect(result.preview?.rows[0]?.reference).toBe("00123");
    expect(result.invalidExportDisabled).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.historicalDownload).toBe("old;result");
    expect(result.storageDisabledDownload).toContain("00123;12,34");
    expect(result.storageDisabledStatus).toStartWith("Download bereit.");
  } finally {
    await browser.close();
  }
}, 45000);
