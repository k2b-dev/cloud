import { expect, test } from "bun:test";
import { isPdfName, pdfBody } from "./pdf-body";

const chunked = (...parts: string[]) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: () => cancelled };
};

test("only a .pdf name counts as a PDF", () => {
  expect(isPdfName("Q3 Report.PDF")).toBe(true);
  expect(isPdfName("report.pdf.html")).toBe(false);
  expect(isPdfName("pdf")).toBe(false);
});

test("a PDF streams through unchanged, even when its signature spans chunks", async () => {
  const source = chunked("%P", "DF-1.7\n", "rest of the document");
  expect(await new Response(await pdfBody(source.response)).text()).toBe("%PDF-1.7\nrest of the document");
});

test("bytes before the signature pass as long as a browser viewer still finds it in the first 1024 bytes", async () => {
  for (const content of [["\uFEFF%PDF-1.4\n"], ["x".repeat(1019), "%PDF-1.7\n"]]) {
    const served = await new Response(await pdfBody(chunked(...content).response)).bytes();
    expect(served).toEqual(new TextEncoder().encode(content.join("")));
  }
});

test("content without the PDF signature in its first 1024 bytes is refused before anything is sent", async () => {
  for (const content of [["<html><script>alert(1)</script>"], ["%PD"], ["x".repeat(1020), "%PDF-1.7\n"], []]) {
    await expect(pdfBody(chunked(...content).response)).rejects.toMatchObject({ code: "not_pdf", status: 400 });
  }
});

test("a refused read stops after the first 1024 bytes instead of draining the file", async () => {
  const source = chunked("<html>".padEnd(1024), "%PDF-1.7\n", "rest of the file");
  await expect(pdfBody(source.response)).rejects.toMatchObject({ code: "not_pdf" });
  expect(source.cancelled()).toBe(true);
});

test("a failed storage read is unavailable, not a PDF error", async () => {
  await expect(pdfBody(new Response("gone", { status: 404 }))).rejects.toMatchObject({ code: "unavailable", status: 503 });
});

test("cancelling the served body cancels the storage read", async () => {
  const source = chunked("%PDF-1.7".padEnd(1024), "more", "and more");
  await (await pdfBody(source.response)).cancel();
  expect(source.cancelled()).toBe(true);
});
