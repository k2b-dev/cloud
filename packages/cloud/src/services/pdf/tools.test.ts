import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { extractZip } from "@k2b/stdlib/browser";
import { DownstreamBusyError, downstreamBudget } from "../downstream-budget";
import { type GotenbergConfig, type GotenbergFetch, mergePdfsWithConfig } from "./gotenberg";
import { type PdfToolOperation, pdfToolLimits, runPdfToolWithConfig } from "./tools";

const config: GotenbergConfig = {
  url: "http://renderer.invalid",
  username: "operator",
  password: "test",
  timeoutMs: 10_000,
  maxPdfBytes: 10_240,
  maxHtmlBytes: 1024 * 1024,
};
const source = (pages: number[] = [1, 2, 3]) => new Blob([`%PDF-${pages.join(",")}`], { type: "application/pdf" });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const parsePdf = (value: string) => value.slice(5).split(",").map(Number);
let admission: ReturnType<typeof spyOn<typeof downstreamBudget, "acquire">>;
beforeEach(() => {
  admission = spyOn(downstreamBudget, "acquire").mockResolvedValue(() => {});
});
afterEach(() => admission.mockRestore());

/** Models the default pdfcpu engine: page selections are sets, not order. */
function renderer() {
  const calls: { path: string; fields: FormData; signal?: AbortSignal | null }[] = [];
  const transport: GotenbergFetch = async (url, init) => {
    const fields = init!.body as FormData;
    const path = new URL(String(url)).pathname;
    calls.push({ path, fields, signal: init!.signal });
    expect(new Headers(init!.headers).get("authorization")).toBe(`Basic ${Buffer.from("operator:test").toString("base64")}`);
    const files = fields.getAll("files");
    const parsed = await Promise.all(
      files.map(async (file) => {
        if (!(file instanceof File)) throw new Error("file expected");
        return { name: file.name, pages: parsePdf(await file.text()) };
      }),
    );
    if (path.endsWith("/metadata/read"))
      return Response.json(Object.fromEntries(parsed.map((file) => [file.name, { PageCount: file.pages.length }])));
    let pages = parsed.flatMap((file) => file.pages);
    if (path.endsWith("/split")) {
      expect(fields.get("splitMode")).toBe("pages");
      expect(fields.get("splitUnify")).toBe("true");
      const selection = String(fields.get("splitSpan")).split(",").map(Number);
      pages = pages.filter((_, i) => selection.includes(i + 1));
    }
    if (path.endsWith("/rotate")) {
      const selection = fields.has("rotatePages") ? String(fields.get("rotatePages")).split(",").map(Number) : pages.map((_, i) => i + 1);
      pages = pages.map((page, i) => (selection.includes(i + 1) ? page + Number(fields.get("rotateAngle")) * 100 : page));
    }
    return new Response(`%PDF-${pages.join(",")}`, { headers: { "content-type": "application/pdf" } });
  };
  return { calls, fetch: transport };
}

describe("bounded PDF operations", () => {
  test("merge bounds total inputs before allocation or admission", async () => {
    await expect(
      mergePdfsWithConfig({ files: [{ pdf: new Uint8Array(6000) }, { pdf: new Uint8Array(6000) }] }, config, {
        fetch: async () => new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }),
      }),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(admission).not.toHaveBeenCalled();
  });

  test("merge preserves source order even beyond nine inputs and ignores source names", async () => {
    const upstream = renderer();
    const result = await runPdfToolWithConfig(
      { files: Array.from({ length: 12 }, (_, i) => source([i + 1])), operation: { kind: "merge" } },
      config,
      upstream,
    );
    expect(decode(result.data)).toBe("%PDF-1,2,3,4,5,6,7,8,9,10,11,12");
    expect(upstream.calls.map((c) => c.path)).toEqual(["/forms/pdfengines/metadata/read", "/forms/pdfengines/merge"]);
    expect(upstream.calls[1]!.fields.getAll("files").map((f) => f instanceof File && f.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(6, "0")}.pdf`),
    );
  });

  test("extract and selective/all-page rotation use the supported exact fields", async () => {
    const upstream = renderer();
    expect(
      decode((await runPdfToolWithConfig({ files: [source()], operation: { kind: "extract", pages: [1, 3] } }, config, upstream)).data),
    ).toBe("%PDF-1,3");
    expect(
      decode(
        (await runPdfToolWithConfig({ files: [source()], operation: { kind: "rotate", pages: [2], angle: 90 } }, config, upstream)).data,
      ),
    ).toBe("%PDF-1,9002,3");
    expect(
      decode((await runPdfToolWithConfig({ files: [source()], operation: { kind: "rotate", angle: 180 } }, config, upstream)).data),
    ).toBe("%PDF-18001,18002,18003");
  });

  test("reorder preserves a non-monotonic permutation with the default set-sorting engine", async () => {
    const upstream = renderer();
    const result = await runPdfToolWithConfig(
      { files: [source([1, 2, 3, 4, 5])], operation: { kind: "reorder", pages: [5, 2, 4, 1, 3] } },
      config,
      upstream,
    );
    expect(decode(result.data)).toBe("%PDF-5,2,4,1,3");
    expect(upstream.calls.filter((c) => c.path.endsWith("/split")).map((c) => c.fields.get("splitSpan"))).toEqual(["5", "2,4", "1,3"]);
    expect(upstream.calls).toHaveLength(5); // one inspection, three runs, one merge
  });

  test("split returns a complete, ordered ZIP with safe deterministic names", async () => {
    const result = await runPdfToolWithConfig(
      { files: [source()], operation: { kind: "split", groups: [[3], [1, 2]] } },
      config,
      renderer(),
    );
    expect(result.contentType).toBe("application/zip");
    expect(result.extension).toBe("zip");
    const entries = await extractZip(result.data, { maxBytes: config.maxPdfBytes, maxEntries: 2 });
    expect(entries.map((entry) => [entry.filename, decode(entry.data)])).toEqual([
      ["part-000001.pdf", "%PDF-3"],
      ["part-000002.pdf", "%PDF-1,2"],
    ]);
  });

  test("rejects wrong MIME, magic, duplicate/order/missing/out-of-range pages without partial results", async () => {
    const upstream = renderer();
    await expect(
      runPdfToolWithConfig({ files: [new Blob(["%PDF-1"], { type: "image/png" })], operation: { kind: "merge" } }, config, upstream),
    ).rejects.toMatchObject({ code: "bad_input" });
    await expect(
      runPdfToolWithConfig({ files: [new Blob(["hello"], { type: "application/pdf" })], operation: { kind: "merge" } }, config, upstream),
    ).rejects.toMatchObject({ code: "bad_input" });
    const invalidOperations: PdfToolOperation[] = [
      { kind: "extract", pages: [3, 1] },
      { kind: "reorder", pages: [1, 1, 3] },
      { kind: "reorder", pages: [3, 1] },
      { kind: "extract", pages: [4] },
      { kind: "split", groups: [[1], [1]] },
    ];
    for (const operation of invalidOperations) {
      await expect(runPdfToolWithConfig({ files: [source()], operation }, config, upstream)).rejects.toMatchObject({ code: "bad_input" });
    }
    expect(upstream.calls.every((c) => c.path.endsWith("/metadata/read"))).toBe(true);
  });

  test("rejects excessive source page counts before downstream transforms", async () => {
    const upstream = renderer();
    const limited = { ...config, maxHtmlBytes: 16 * 1024 };
    expect(pdfToolLimits(limited).maxPages).toBe(2);
    await expect(
      runPdfToolWithConfig({ files: [source()], operation: { kind: "rotate", angle: 90 } }, limited, upstream),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(upstream.calls).toHaveLength(1);
  });

  test("counts all repeated source uploads before extracting any reordered parts", async () => {
    const upstream = renderer();
    const file = new Blob(["%PDF-1,2,3", " ".repeat(6000)], { type: "application/pdf" });
    await expect(
      runPdfToolWithConfig({ files: [file], operation: { kind: "reorder", pages: [3, 2, 1] } }, config, upstream),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(upstream.calls).toHaveLength(1);
  });

  test("counts inspection, ascending runs and final merge against one call limit", async () => {
    const upstream = renderer();
    const limited = { ...config, timeoutMs: 400 };
    expect(pdfToolLimits(limited).maxPages).toBe(3);
    await expect(
      runPdfToolWithConfig({ files: [source()], operation: { kind: "reorder", pages: [3, 2, 1] } }, limited, upstream),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(upstream.calls).toHaveLength(1);
  });

  test("aborting between split groups produces no partial ZIP and no further call", async () => {
    const upstream = renderer();
    const abort = new AbortController();
    let calls = 0;
    const fetch: GotenbergFetch = async (url, init) => {
      calls++;
      const response = await upstream.fetch(url, init);
      if (calls === 2) abort.abort();
      return response;
    };
    await expect(
      runPdfToolWithConfig({ files: [source()], operation: { kind: "split", groups: [[1], [2, 3]] } }, config, {
        fetch,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(2);
  });

  test("counts merge inputs and cumulative intermediate output rather than resetting each call", async () => {
    let calls = 0;
    const fetch: GotenbergFetch = async (url) => {
      calls++;
      if (String(url).endsWith("/metadata/read")) return Response.json({ "000001.pdf": { PageCount: 3 } });
      return new Response(`%PDF-${"x".repeat(4000)}`, { headers: { "content-type": "application/pdf" } });
    };
    await expect(
      runPdfToolWithConfig({ files: [source()], operation: { kind: "reorder", pages: [3, 2, 1] } }, config, { fetch }),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(calls).toBe(4); // no final merge after intermediate retention overflows
  });

  test("bounds metadata and rejects missing/malformed page counts", async () => {
    for (const value of [{ "000001.pdf": {} }, { "000001.pdf": { PageCount: "unknown" } }, { "000001.pdf": { PageCount: -1 } }, null]) {
      await expect(
        runPdfToolWithConfig({ files: [source()], operation: { kind: "merge" } }, config, { fetch: async () => Response.json(value) }),
      ).rejects.toMatchObject({ code: "bad_response" });
    }
    await expect(
      runPdfToolWithConfig({ files: [source()], operation: { kind: "merge" } }, config, {
        fetch: async () => Response.json({ title: "x".repeat(config.maxHtmlBytes) }),
      }),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
  });

  test("reads a renderer response fragmented into one-byte chunks", async () => {
    const upstream = renderer();
    const fetch: GotenbergFetch = async (url, init) => {
      const response = await upstream.fetch(url, init);
      const contentType = response.headers.get("content-type")!;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let offset = 0;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (offset === bytes.length) controller.close();
              else controller.enqueue(bytes.subarray(offset, ++offset));
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": contentType } },
      );
    };
    const result = await runPdfToolWithConfig({ files: [source()], operation: { kind: "merge" } }, config, { fetch });
    expect(decode(result.data)).toBe("%PDF-1,2,3");
  });

  test("shared busy admission prevents every renderer request", async () => {
    admission.mockRejectedValue(new DownstreamBusyError("gotenberg"));
    const upstream = renderer();
    await expect(runPdfToolWithConfig({ files: [source()], operation: { kind: "merge" } }, config, upstream)).rejects.toMatchObject({
      code: "busy",
    });
    expect(upstream.calls).toHaveLength(0);
  });

  test("abort cancels a stalled response reader and releases shared admission", async () => {
    const abort = new AbortController();
    let released = 0;
    let cancelled = 0;
    admission.mockResolvedValue(() => {
      released++;
    });
    const promise = runPdfToolWithConfig({ files: [source()], operation: { kind: "merge" } }, config, {
      signal: abort.signal,
      fetch: async () => {
        queueMicrotask(() => abort.abort());
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(1);
    expect(released).toBe(1);
  });
});
