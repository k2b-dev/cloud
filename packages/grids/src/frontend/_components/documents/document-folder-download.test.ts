import { expect, test } from "bun:test";
import { collectDocumentFolder, FOLDER_DOWNLOAD_MAX_BYTES } from "./document-folder-download";
import type { PublicDocument, PublicDocumentBrowseResponse } from "./public-document-types";

const document = (id: string, sizeBytes = 3): PublicDocument => ({
  id,
  baseId: "BASE01",
  tableId: null,
  recordId: null,
  templateId: null,
  number: id,
  filename: "same.pdf",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  tags: [],
  renderer: { kind: "html" },
  validationStatus: "unchecked",
  sourceRecordCount: null,
  dataSnapshot: null,
  primaryArtifactKey: "pdf",
  downloadUrl: "/api/grids/documents/DOC/download",
  artifacts: [
    {
      key: "pdf",
      filename: "same.pdf",
      mimeType: "application/pdf",
      sizeBytes,
      sha256: "0".repeat(64),
      downloadUrl: "/api/grids/documents/DOC/artifacts/pdf",
    },
  ],
});
const page = (items: PublicDocument[] = [], extra: Partial<PublicDocumentBrowseResponse> = {}): PublicDocumentBrowseResponse => ({
  items,
  folders: [],
  path: [],
  hasMore: false,
  cursor: null,
  ...extra,
});
const signal = () => new AbortController().signal;

test("folder export follows nested folders and cursors and disambiguates duplicate filenames", async () => {
  const calls: string[] = [];
  const progress: number[] = [];
  const entries = await collectDocumentFolder({
    path: ["2026"],
    signal: signal(),
    onProgress: (count) => progress.push(count),
    async loadPage(path, cursor) {
      calls.push(`${path.join("/")}:${cursor ?? ""}`);
      if (path.length === 1)
        return page([], { folders: [{ kind: "month", key: "09", label: "September", path: ["2026", "09"], count: 2 }] });
      return cursor ? page([document("DOC002")]) : page([document("DOC001")], { hasMore: true, cursor: "next" });
    },
    download: async () => new Response("pdf"),
  });
  expect(calls).toEqual(["2026:", "2026/09:", "2026/09:next"]);
  expect(entries.map((entry) => entry.filename)).toEqual(["09/DOC001-same.pdf", "09/DOC002-same.pdf"]);
  expect(progress).toEqual([1, 2]);
});

test("an inaccessible artifact aborts the whole export", async () => {
  await expect(
    collectDocumentFolder({
      path: [],
      signal: signal(),
      onProgress() {},
      loadPage: async () => page([document("DOC001")]),
      download: async () => new Response("denied", { status: 403 }),
    }),
  ).rejects.toThrow("incomplete");
});

test("oversized metadata is rejected before fetching bytes", async () => {
  let fetched = false;
  await expect(
    collectDocumentFolder({
      path: [],
      signal: signal(),
      onProgress() {},
      loadPage: async () => page([document("DOC001", FOLDER_DOWNLOAD_MAX_BYTES + 1)]),
      download: async () => {
        fetched = true;
        return new Response("pdf");
      },
    }),
  ).rejects.toThrow("limit");
  expect(fetched).toBe(false);
});

test("truncated and oversized responses cannot silently become archive files", async () => {
  for (const body of ["p", "pdf-extra"]) {
    await expect(
      collectDocumentFolder({
        path: [],
        signal: signal(),
        onProgress() {},
        loadPage: async () => page([document("DOC001")]),
        download: async () => new Response(body),
      }),
    ).rejects.toThrow();
  }
});

test("cancelled exports stop before the next request", async () => {
  const controller = new AbortController();
  let requests = 0;
  await expect(
    collectDocumentFolder({
      path: [],
      signal: controller.signal,
      onProgress() {
        controller.abort();
      },
      loadPage: async () => page([document("DOC001")], { hasMore: true, cursor: "next" }),
      download: async () => {
        requests++;
        return new Response("pdf");
      },
    }),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

test("looping cursors and invalid folder paths fail instead of looping", async () => {
  await expect(
    collectDocumentFolder({
      path: [],
      signal: signal(),
      onProgress() {},
      loadPage: async () => page([], { hasMore: true, cursor: "same" }),
      download: async () => new Response("pdf"),
    }),
  ).rejects.toThrow("incomplete");
  await expect(
    collectDocumentFolder({
      path: ["2026"],
      signal: signal(),
      onProgress() {},
      loadPage: async () => page([], { folders: [{ kind: "year", key: "2025", label: "2025", path: ["2025"], count: 1 }] }),
      download: async () => new Response("pdf"),
    }),
  ).rejects.toThrow("incomplete");
});

test("folder names cannot create parent-directory archive entries", async () => {
  const entries = await collectDocumentFolder({
    path: [],
    signal: signal(),
    onProgress() {},
    loadPage: async (path) =>
      path.length
        ? page([document("DOC001")])
        : page([], {
            folders: [{ kind: "year", key: ".. ", label: "Folder", path: ["2026"], count: 1 }],
          }),
    download: async () => new Response("pdf"),
  });
  expect(entries[0]?.filename).toBe("_/DOC001-same.pdf");
});
