import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import type { PublicDocument } from "./public-document-types";

const { DocumentDetailsDialog } = await import("./DocumentDetailsDialog");

const document: PublicDocument = {
  id: "DOC001",
  baseId: "BASE01",
  tableId: "TABLE1",
  recordId: "RECORD",
  templateId: "TMPL01",
  number: "INV-2026-1",
  filename: "invoice.pdf",
  createdAt: "2026-09-09T12:00:00Z",
  createdBy: "creator-uuid",
  tags: [],
  renderer: { kind: "html" },
  primaryArtifactKey: "pdf",
  downloadUrl: "/api/grids/documents/DOC/download",
  sourceRecordCount: null,
  dataSnapshot: null,
  validationStatus: "warning",
  artifacts: [
    {
      key: "pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      downloadUrl: "/api/grids/documents/DOC/artifacts/pdf",
    },
    {
      key: "structured",
      filename: "invoice.xml",
      mimeType: "application/xml",
      sizeBytes: 512,
      sha256: "b".repeat(64),
      downloadUrl: "/api/grids/documents/DOC/artifacts/structured",
    },
  ],
};

test("document summary keeps files and warnings visible but defers technical data and links", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: { document, templateName: "Invoice", canWrite: true, onDownload: () => {}, onGenerateAgain: () => {} },
      close: () => {},
    }),
  );
  expect(html).toContain("invoice.xml");
  expect(html).toContain("Warning");
  expect(html).toContain("Technical details");
  expect(html).toContain("Share links");
  expect(html).toContain("IDs &amp; checksums");
  expect(html).toContain("grids-document-detail-row");
  expect(html).not.toContain("No active links");
  expect(html).toContain("More actions");
  expect(html).not.toContain("SHA-256");
  expect(html).not.toContain("creator-uuid");
  expect(html).not.toContain("No public links");
  expect(html).not.toContain("border-subtle");
  expect(html.match(/Download PDF/g)).toHaveLength(1);
});

test("read-only document summary has no link management or generation action", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: { document, canWrite: false, onDownload: () => {}, onGenerateAgain: () => {} },
      close: () => {},
    }),
  );
  expect(html).not.toContain("Share links");
  expect(html).not.toContain("More actions");
  expect(html).toContain("Download PDF");
});

test("source inspection avoids duplicating a direct single-record link", () => {
  for (const [recordId, count, visible] of [
    ["RECORD", 1, false],
    ["RECORD", 2, true],
    [null, 1, true],
    [null, 0, false],
  ] as const) {
    const html = renderToString(() =>
      createComponent(DocumentDetailsDialog, {
        args: { document: { ...document, recordId, sourceRecordCount: count }, canWrite: false, onDownload: () => {} },
        close: () => {},
      }),
    );
    expect(html.includes("Source records")).toBe(visible);
  }
});

test("CSV primary is shown once with an authorized download and public sharing", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: {
        document: {
          ...document,
          filename: "report.csv",
          primaryArtifactKey: "csv",
          downloadUrl: "/api/grids/documents/DOC/download",
          artifacts: [
            {
              key: "csv",
              filename: "report.csv",
              mimeType: "text/csv",
              sizeBytes: 200,
              sha256: "c".repeat(64),
              downloadUrl: "/api/grids/documents/DOC/artifacts/csv",
            },
          ],
        },
        canWrite: true,
        onDownload: () => {},
      },
      close: () => {},
    }),
  );
  expect(html).toContain("CSV");
  expect(html).toContain("Preview");
  expect(html.match(/report.csv/g)).toHaveLength(1);
  expect(html).toContain("Download");
  expect(html).not.toContain("Download PDF");
  expect(html).toContain("Share links");
});

test("a primary file outside the supported document formats offers no public sharing", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: {
        document: {
          ...document,
          filename: "page.html",
          primaryArtifactKey: "page",
          artifacts: [{ key: "page", filename: "page.html", mimeType: "text/html", sizeBytes: 200, sha256: "c".repeat(64) }],
        },
        canWrite: true,
        onDownload: () => {},
      },
      close: () => {},
    }),
  );
  expect(html).toContain("Download");
  expect(html).not.toContain("Share links");
});

test("large text artifacts remain downloadable without an unbounded preview", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: {
        document: {
          ...document,
          primaryArtifactKey: "json",
          downloadUrl: "/api/grids/documents/DOC/download",
          filename: "large.json",
          artifacts: [
            {
              key: "json",
              filename: "large.json",
              mimeType: "application/json",
              sizeBytes: 3 * 1024 * 1024,
              sha256: "c".repeat(64),
              downloadUrl: "/api/grids/documents/DOC/artifacts/json",
            },
          ],
        },
        canWrite: false,
        onDownload: () => {},
      },
      close: () => {},
    }),
  );
  expect(html).not.toContain(">Preview<");
  expect(html).toContain("Download");
});

test("workflow documents do not invent record and template navigation", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: {
        document: {
          ...document,
          tableId: null,
          recordId: null,
          templateId: null,
          dataSnapshot: { capturedAt: "2026-09-08T12:00:00Z", rowCount: 42 },
        },
        canWrite: false,
        onDownload: () => {},
      },
      close: () => {},
    }),
  );
  expect(html).not.toContain("/table/");
  expect(html).not.toContain("/document/");
  expect(html).not.toContain("Source record");
  expect(html).toContain("Workflow data");
  expect(html).toContain("42 rows");
  expect(html).toContain("Data captured");
  expect(html).toContain("Download PDF");
});

test("unchecked output is shown neutrally without claiming validity or a warning", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: { document: { ...document, validationStatus: "unchecked" }, canWrite: false, onDownload: () => {} },
      close: () => {},
    }),
  );
  expect(html).toContain("Not checked");
  expect(html).not.toContain(">Valid<");
  expect(html).not.toContain(">Warning<");
});
