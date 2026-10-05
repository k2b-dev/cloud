import { afterEach, describe, expect, test } from "bun:test";
import type { SearchItem, SearchStreamLine } from "../api/search/schemas";
import {
  applySearchLine,
  emptySearchRun,
  failedSearchApps,
  searchFinished,
  searchingApps,
  streamCloudResourceSearch,
} from "./search-stream";

const item = (appId: string, id: string): SearchItem => ({
  appId,
  appName: appId,
  appIcon: "ti ti-box",
  readable: true,
  ref: { type: `${appId}.item`, id },
  title: id,
  href: `/app/${appId}/${id}`,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const respondWith = (response: Response) => {
  globalThis.fetch = Object.assign(async () => response, { preconnect: originalFetch.preconnect });
};
const collect = async () => {
  const lines: SearchStreamLine[] = [];
  await streamCloudResourceSearch("/api/search?q=plan", {
    signal: new AbortController().signal,
    locale: "en",
    onLine: (line) => lines.push(line),
  });
  return lines;
};

describe("streamed search run", () => {
  test("accepts one line per app it is waiting for and only appends rows", () => {
    let run = applySearchLine(emptySearchRun(), { type: "start", query: "plan", apps: [], providers: ["files", "mail"] });
    expect(searchingApps(run)).toEqual(["files", "mail"]);
    run = applySearchLine(run, { type: "provider", provider: "mail", status: "ok", results: [item("mail", "a")], ms: 3 });
    // A second line for the same app, or a line for an app the run never started, changes nothing.
    const again = applySearchLine(run, { type: "provider", provider: "mail", status: "ok", results: [item("mail", "b")], ms: 4 });
    expect(again).toBe(run);
    expect(applySearchLine(run, { type: "provider", provider: "other", status: "ok", results: [item("other", "c")], ms: 4 })).toBe(run);
    run = applySearchLine(run, { type: "provider", provider: "files", status: "timeout", results: [], ms: 8000 });
    run = applySearchLine(run, { type: "done", status: "partial", count: 1 });
    expect(run.blocks.map((block) => block.appId)).toEqual(["mail"]);
    expect(failedSearchApps(run)).toEqual([{ appId: "files", status: "timeout" }]);
    expect(searchFinished(run)).toBeTrue();
  });

  test("reads lines split across chunks", async () => {
    const text = [
      { type: "start", query: "plan", apps: [], providers: ["files"] },
      { type: "provider", provider: "files", status: "ok", results: [item("files", "a")], ms: 1 },
      { type: "done", status: "complete", count: 1 },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");
    const bytes = new TextEncoder().encode(text);
    respondWith(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    expect((await collect()).map((line) => line.type)).toEqual(["start", "provider", "done"]);
  });

  test("fails when the stream ends before its last line", async () => {
    respondWith(
      new Response(`${JSON.stringify({ type: "start", query: "plan", apps: [], providers: ["files"] })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    await expect(collect()).rejects.toThrow("Search stream ended early");
  });

  test("reads the merged JSON of an older Core as the same lines", async () => {
    respondWith(
      Response.json({ query: "plan", count: 2, apps: [], items: [item("files", "a"), item("mail", "b")], failedApps: ["notebooks"] }),
    );
    const run = (await collect()).reduce(applySearchLine, emptySearchRun());
    expect(run.providers).toEqual(["files", "mail", "notebooks"]);
    expect(run.blocks.map((block) => block.appId)).toEqual(["files", "mail"]);
    expect(failedSearchApps(run)).toEqual([{ appId: "notebooks", status: "error" }]);
    expect(searchFinished(run)).toBeTrue();
  });
});
