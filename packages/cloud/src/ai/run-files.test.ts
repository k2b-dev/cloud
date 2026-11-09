import { expect, mock, test } from "bun:test";
import { aiModelFixture } from "./model-fixture";
import { createAiRunFiles } from "./run-files";

const ref = { id: "sealed-this-run", mediaType: "text/plain", size: 5, name: "a.txt" };
function fixture(vision = true, maxInputTokens = 100_000) {
  const read = mock(async () => new TextEncoder().encode("hello"));
  const describe = mock(async () => "Visual evidence");
  const render = mock(async (_bytes: Uint8Array, pages?: number[], _signal?: AbortSignal, maxPages = 20) => ({
    totalPages: 30,
    pages: (pages ?? Array.from({ length: maxPages }, (_, i) => i + 1)).map((page) => ({ page, png: "YQ==" })),
  }));
  const files = createAiRunFiles({
    read,
    describe,
    render,
    model: { profile: aiModelFixture({ capabilities: vision ? ["vision"] : [] }) },
    maxInputTokens,
    signal: new AbortController().signal,
  });
  return { files, read, describe, render };
}

test("viewer accepts only exact refs seen in this invocation, including input and tool results", async () => {
  const a = fixture(),
    b = fixture();
  await expect(a.files.read({ ref })).rejects.toThrow("code_file_not_in_run");
  a.files.add({ nested: [ref] });
  expect((await a.files.read({ ref })).content).toBe("hello");
  await expect(a.files.read({ ref: { ...ref, size: 4 } })).rejects.toThrow("code_file_not_in_run");
  await expect(b.files.read({ ref })).rejects.toThrow("code_file_not_in_run");
  b.files.add({ data: { file: ref } });
  expect((await b.files.read({ ref })).content).toBe("hello");
  expect(a.read).toHaveBeenCalledTimes(1);
});

test("attachments and viewer share one reader, and an owning app refusal stays visible", async () => {
  const { files, read } = fixture();
  files.add([ref]);
  expect(await files.attach([ref])).toHaveLength(1);
  await files.read({ ref });
  expect(read).toHaveBeenCalledTimes(1);
  const refusal = Object.assign(new Error("source app refused (403)"), { code: "code_file_source_refused", status: 403 });
  read.mockRejectedValue(refusal);
  const denied = { ...ref, id: "denied" };
  files.add(denied);
  await expect(files.read({ ref: denied })).rejects.toBe(refusal);
});

test("native images and PDF pages reach vision models, while text models use one description", async () => {
  const image = { ...ref, mediaType: "image/png" },
    pdf = { ...ref, id: "pdf", mediaType: "application/pdf" };
  const native = fixture();
  native.files.add([image, pdf]);
  await native.files.view({ ref: image });
  const pages = await native.files.view({ ref: pdf });
  expect(pages.pages).toHaveLength(20);
  expect(native.files.media().filter((part) => typeof part !== "string" && part.type === "file")).toHaveLength(21);
  expect(native.describe).not.toHaveBeenCalled();
  await native.files.view({ ref: pdf });
  expect(native.render).toHaveBeenCalledTimes(1);
  const text = fixture(false);
  text.files.add(image);
  expect((await text.files.view({ ref: image })).description).toBe("Visual evidence");
  expect(text.describe).toHaveBeenCalledTimes(1);
  expect(text.files.media()).toEqual([]);
});

test("page count and model token budget bound each look before a read", async () => {
  const small = fixture(true, 0),
    pdf = { ...ref, mediaType: "application/pdf" };
  small.files.add(pdf);
  await expect(small.files.view({ ref: pdf })).rejects.toThrow("code_file_page_limit");
  expect(small.read).not.toHaveBeenCalled();
  const normal = fixture();
  normal.files.add(pdf);
  // Input parsing happens at the public tool seam; direct callers get the same page schema.
  const { AiRunViewInput } = await import("./run-files");
  expect(AiRunViewInput.safeParse({ ref: pdf, pages: Array.from({ length: 21 }, (_, i) => i + 1) }).success).toBe(false);
});

test("byte and file count budgets reject before reading; declared byte mismatch cannot enter the cache", async () => {
  const a = fixture();
  const huge = { ...ref, id: "huge", mediaType: "image/png", size: 10 * 1024 * 1024 + 1 };
  a.files.add(huge);
  await expect(a.files.view({ ref: huge })).rejects.toThrow("code_file_size_limit");
  expect(a.read).not.toHaveBeenCalled();
  for (let i = 0; i < 16; i++) {
    const next = { ...ref, id: `ref-${i}` };
    a.files.add(next);
    await a.files.read({ ref: next });
  }
  a.files.add(ref);
  await expect(a.files.read({ ref })).rejects.toThrow("code_file_byte_limit");
  const b = fixture();
  b.files.add({ ...ref, size: 4 });
  await expect(b.files.read({ ref: { ...ref, size: 4 } })).rejects.toThrow("code_file_size_mismatch");
});

test("text-only vision fallback shares the aggregate visual byte budget across looks", async () => {
  const f = fixture(false);
  const image = { ...ref, mediaType: "image/png", size: 9 * 1024 * 1024 };
  f.read.mockResolvedValue(new Uint8Array(image.size));
  f.files.add(image);
  for (let i = 0; i < 4; i++) await f.files.view({ ref: image, prompt: `Look ${i}` });
  await expect(f.files.view({ ref: image, prompt: "Another look" })).rejects.toThrow("code_file_byte_limit");
  expect(f.describe).toHaveBeenCalledTimes(4);
  expect(f.read).toHaveBeenCalledTimes(1);
});
