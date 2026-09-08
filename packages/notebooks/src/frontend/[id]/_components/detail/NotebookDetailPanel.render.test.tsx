import { describe, expect, test } from "bun:test";
import { renderToString } from "solid-js/web";
import type { PublicNoteComment } from "../../../../api/public-resources";
import type { NamedBlockSummary } from "../../../../lib/named-blocks";
import type { Backlink } from "../../../../service/links";
import type { Attachment } from "../editor/attachments-client";
import type { TaskProgress } from "./tasks";
import type { TocItem } from "./toc";
import "./ssr-test-plugin";

const { default: NotebookDetailPanel } = await import("./NotebookDetailPanel.island.tsx");

const now = "2026-08-09T10:00:00.000Z";
const comment: PublicNoteComment = {
  id: "comment1",
  notebookId: "book01",
  noteId: "note01",
  authorUserId: "user-id",
  authorDisplayName: "Ada Example",
  authorAvatarHash: null,
  content: "**Decision:** ship the handbook update.",
  createdAt: now,
  updatedAt: now,
  canEdit: true,
  canDelete: true,
};
const tocItems: TocItem[] = [
  { id: "overview", level: 1, text: "Overview" },
  { id: "details", level: 2, text: "Details" },
];
const taskProgress: TaskProgress = { done: 2, total: 3 };
const namedBlocks: NamedBlockSummary[] = [{ name: "inventory", type: "table", line: 8 }];
const attachments: Attachment[] = [
  {
    id: "attach1",
    kind: "file",
    filename: "plan.pdf",
    notebookId: "notebook-id",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    createdBy: "user-id",
    createdAt: now,
  },
];
const backlinks: Backlink[] = [
  {
    noteId: "source",
    title: "Source note",
    notebookId: "other1",
    notebookName: "Other notebook",
    updatedAt: now,
  },
];

const renderPanel = (overrides: Partial<Parameters<typeof NotebookDetailPanel>[0]> = {}) =>
  renderToString(() => (
    <NotebookDetailPanel
      mode="edit"
      initiallyOpen
      tocItems={tocItems}
      taskProgress={taskProgress}
      attachments={attachments}
      backlinks={backlinks}
      namedBlocks={namedBlocks}
      currentNotebookId="book01"
      notebookId="book01"
      noteId="note01"
      noteTitle="Migration plan"
      contentMd="# Migration plan"
      createdAt={now}
      updatedAt={now}
      lockedAt={null}
      historyIncomplete={false}
      isLocked={false}
      canWrite
      currentUserId="user-id"
      initialCommentsPage={{ items: [], page: 1, perPage: 30, total: 0, hasNext: false }}
      dateConfig={{ locale: "en", timeZone: "UTC" }}
      {...overrides}
    />
  ));

const legacyDetailClasses = [
  'class="detail-header',
  'class="detail-stack',
  'class="detail-section',
  'class="detail-row',
  'class="detail-facts',
];

describe("Notebook note detail panel", () => {
  test("offers presentation actions appropriate to mode, permission and lock", () => {
    const edit = renderPanel();
    expect(edit).toContain("/notes/note01?mode=book");
    expect(edit).toContain("/notes/note01?mode=readonly");
    const read = renderPanel({ mode: "read" });
    expect(read).toContain("/notes/note01?mode=book");
    expect(read).toContain("/notes/note01?mode=write");
    expect(read).not.toContain("/notes/note01?mode=readonly");
    expect(renderPanel({ mode: "read", lockedAt: now, isLocked: true })).not.toContain("/notes/note01?mode=write");
    expect(renderPanel({ mode: "read", canWrite: false })).not.toContain("/notes/note01?mode=write");
  });
  test("formats relative dates with the request locale", () => {
    const html = renderPanel({ dateConfig: { locale: "de-CH", timeZone: "UTC" } });

    expect(html).toContain("09 Aug. 2026");
  });

  test("composes note context through the grouped shared detail panel contract", () => {
    const html = renderPanel();

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Migration plan</h2>");
    expect(html).toContain('class="k2b-detail-panel__header-icon"');
    expect(html).toContain('aria-label="Note actions"');
    expect(html).toContain('class="k2b-detail-panel__summary"');
    expect(html).toContain("Task progress");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Completed note tasks"');
    expect(html).toContain('aria-label="Note structure"');
    expect(html).toContain('aria-label="Related content"');
    expect(html).toContain('aria-label="Note context"');
    expect(html).toContain('style="padding-left: 0.75rem"');
    expect(html.match(/<details class="k2b-detail-panel__section" open/g)).toHaveLength(4);
    expect(html).toContain('data-layout="rows"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('data-scroll-preserve="notebook-detail"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain("notebook-detail-panel-header");
    for (const className of legacyDetailClasses) expect(html).not.toContain(className);
  });

  test("preserves note commands and destination links", () => {
    const html = renderPanel();

    expect(html).toContain('aria-label="Show Markdown source"');
    expect(html).toContain("Edit with AI");
    expect(html).toContain('aria-label="Copy note content"');
    expect(html).toContain('aria-label="Download note as Markdown"');
    expect(html).toContain('aria-label="Download note as PDF"');
    expect(html).toContain('href="/app/notebooks/book01/notes/note01?mode=versions"');
    expect(html).toContain('href="/app/notebooks/book01?mode=graph&amp;note=note01"');
    expect(html).toContain('href="#overview"');
    expect(html).not.toContain("Copy script snippet");
    expect(html).toContain("inventory");
    expect(html).toContain("plan.pdf");
    expect(html).toContain('href="/app/notebooks/other1/notes/source"');
    expect(html).toContain('aria-label="Close note details"');
  });

  test("renders the shared discussion contract with SSR comments", () => {
    const html = renderPanel({ initialCommentsPage: { items: [comment], page: 1, perPage: 30, total: 1, hasNext: false } });

    expect(html).toContain("Comments");
    expect(html).toContain("Add comment");
    expect(html).toContain("Ada Example");
    expect(html).toContain("<strong>Decision:</strong> ship the handbook update.");
    expect(html).toContain('aria-label="Edit comment"');
    expect(html).toContain('aria-label="Delete comment"');
  });

  test("keeps discussion writable when a note body is locked", () => {
    const html = renderPanel({ mode: "read", lockedAt: now, isLocked: true, canWrite: true });

    expect(html).toContain("Locked note");
    expect(html).toContain("Comments");
    expect(html).toContain("Add comment");
    expect(html).not.toContain("Edit with AI");
  });

  test("keeps sparse read-only notes sparse and omits editor-only controls", () => {
    const html = renderPanel({
      mode: "read",
      tocItems: [],
      taskProgress: { done: 0, total: 0 },
      attachments: [],
      backlinks: [],
      namedBlocks: [],
      lockedAt: now,
      isLocked: true,
      canWrite: false,
    });

    expect(html).toContain("Locked note");
    expect(html).not.toContain("Task progress");
    expect(html).not.toContain('aria-label="Note structure"');
    expect(html).not.toContain('aria-label="Related content"');
    expect(html).not.toContain("Comments");
    expect(html).toContain('aria-label="Note context"');
    expect(html).not.toContain('aria-label="Show Markdown source"');
    expect(html).not.toContain("Edit with AI");
    expect(html).toContain('aria-label="Copy note content"');
    expect(html).toContain('aria-label="Download note as Markdown"');
    expect(html).toContain('aria-label="Download note as PDF"');
    expect(html).toContain("Info");
    expect(html).toContain("Locked");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
  });
});
