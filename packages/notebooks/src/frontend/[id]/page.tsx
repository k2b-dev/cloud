import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { AppWorkspace, Placeholder } from "@k2b/ui";
import { ssr } from "../../config";
import { katexStylesHref } from "../../lib/katex-assets";
import { notebooksPageMessages } from "../messages";
import { buildNoteUrl } from "../params";
import BookGraphSurface from "./_components/book/BookGraphSurface";
import BookSurface from "./_components/book/BookSurface";
import FloatingEditButton from "./_components/book/FloatingEditButton.island";
import NotebookDetailPanel from "./_components/detail/NotebookDetailPanel.island";
import NoteEditor from "./_components/editor/NoteEditor.client";
import NotePreview from "./_components/editor/NotePreview";
import NotebookGraph from "./_components/graph/NotebookGraph.island";
import NotebookCommands from "./_components/NotebookCommands.island";
import RememberNotebook from "./_components/RememberNotebook.island";
import NotebookSidebar from "./_components/sidebar/NotebookSidebar.island";
import WorkspaceEventBridge from "./_components/sidebar/WorkspaceEventBridge.island";
import VersionHistory from "./_components/versions/VersionHistory.island";
import { loadNotebookPageData } from "./page-data";

export default ssr<AuthContext>(async (c) => {
  const { t } = notebooksPageMessages.resolve([getLocale(c)]);
  const data = await loadNotebookPageData(c);

  if (data.kind === "not_found") return ssr.error(c, 404, { action: { label: t.notebooks, href: "/app/notebooks" } });

  if (data.kind === "access_denied")
    return ssr.error(c, 403, { description: t.accessDeniedDescription, action: { label: t.notebooks, href: "/app/notebooks" } });

  if (data.kind === "redirect") return c.redirect(data.href);

  if (data.isGraphMode && data.graph && data.graphView && data.graphShell === "book") {
    const graph = data.graph;
    const graphView = data.graphView;
    c.get("page").title = data.selectedNote?.title ?? data.notebook.name;
    return () => (
      <Layout context={{ scope: { type: "notebooks.notebook", id: data.notebook.id } }} c={c} fullPage fullWidth title={data.notebook.name}>
        <RememberNotebook notebookId={data.notebook.id} />
        <BookGraphSurface
          userId={data.ctx.userId}
          notebookId={data.notebook.id}
          notebookName={data.notebook.name}
          notebookIcon={data.notebook.icon}
          selectedNoteId={data.selectedNote?.id ?? null}
          tree={data.bookTree}
          tags={data.ctx.tags}
          currentHref={
            data.selectedNote
              ? buildNoteUrl(data.notebook.id, data.selectedNote.id, "book")
              : `/app/notebooks/${data.notebook.id}?mode=book`
          }
          canWrite={data.canWrite}
          locked={!!data.selectedNote?.lockedAt}
          navigationHidden={data.ctx.navigationHidden}
          graph={graph}
          graphView={graphView}
          now={data.now}
          timeZone={data.dateConfig.timeZone ?? "UTC"}
          backHref={data.graphBack}
          graphBack={data.graphBack}
          appUrl={data.appUrl}
          cursor={data.ctx.workspaceCursor}
        />
      </Layout>
    );
  }

  if (data.isBookMode) {
    c.get("page").title = data.selectedNote?.title ?? data.notebook.name;
    return () => (
      <Layout
        context={{ scope: { type: "notebooks.notebook", id: data.notebook.id } }}
        printHint={t.printHint}
        c={c}
        fullPage
        fullWidth
        title={data.notebook.name}
      >
        <RememberNotebook notebookId={data.notebook.id} />
        <BookSurface
          userId={data.ctx.userId}
          notebookId={data.notebook.id}
          notebookName={data.notebook.name}
          notebookIcon={data.notebook.icon}
          selectedNoteId={data.selectedNote?.id ?? null}
          tree={data.bookTree}
          tags={data.ctx.tags}
          html={data.bookHtml}
          noteTitle={data.selectedNote?.title ?? null}
          currentHref={data.currentHref}
          canWrite={data.canWrite}
          locked={!!data.selectedNote?.lockedAt}
          historyIncomplete={data.selectedNote?.historyIncomplete ?? false}
          appUrl={data.appUrl}
          cursor={data.ctx.workspaceCursor}
          navigationHidden={data.ctx.navigationHidden}
          fullWidth={data.ctx.fullWidth}
        />
      </Layout>
    );
  }

  const {
    user,
    notebook,
    isVersionsMode,
    isGraphMode,
    canWrite,
    selectedNoteId,
    selectedNote,
    selectedRouteState,
    tocItems,
    namedBlocks,
    readonlyMode,
    graph,
    versionHistory,
    ctx,
    appUrl,
    currentHref,
    detailPanelOpen,
    showDetailPanel,
    panelAttachments,
    backlinks,
    initialCommentsPage,
    dateConfig,
  } = data;
  const showsEditorToolbar = !!selectedNote && !isVersionsMode && !isGraphMode && !readonlyMode;
  return () => (
    <Layout
      context={{ scope: { type: "notebooks.notebook", id: data.notebook.id } }}
      printHint={t.printHint}
      c={c}
      fullPage
      title={[
        { title: t.start, href: "/" },
        { title: t.notebooks, href: "/app/notebooks" },
        { title: notebook.name, href: `/app/notebooks/${notebook.id}` },
        ...(selectedNote ? [{ title: selectedNote.title }] : []),
      ]}
    >
      <link rel="stylesheet" href={katexStylesHref} />
      <RememberNotebook notebookId={notebook.id} />
      <AppWorkspace mobileSurface="flush" class="notebooks-workspace flex-1 min-h-0">
        <NotebookCommands
          notebookId={notebook.id}
          notebookName={notebook.name}
          canWrite={canWrite}
          ownsSearchNavigation={!selectedNote || isVersionsMode || isGraphMode}
        />
        {/* Live changes reach the page through one workspace socket; a note connects its own only while it is edited. */}
        <WorkspaceEventBridge notebookId={notebook.id} appUrl={appUrl} initialCursor={ctx.workspaceCursor} />

        {/* The writable editor is the one with the toolbar and its navigation toggle. */}
        <NotebookSidebar
          ctx={ctx}
          editorToolbar={showsEditorToolbar}
          current={isGraphMode ? "graph" : undefined}
          // Version history loads as a whole page, so its address is where Links returns to.
          graphBack={isVersionsMode ? c.req.path + new URL(c.req.url).search : data.graphBack}
        />

        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            {isVersionsMode && selectedNoteId ? (
              <VersionHistory
                notebookId={notebook.id}
                noteId={selectedNote?.id ?? selectedNoteId}
                noteTitle={selectedNote?.title ?? ""}
                isLocked={!!selectedNote?.lockedAt}
                currentContentMd={selectedNote?.contentMd ?? null}
                dateConfig={dateConfig}
                initialVersions={versionHistory?.versions}
                initialTotal={versionHistory?.total}
              />
            ) : isGraphMode && graph && data.graphView ? (
              <NotebookGraph
                notebookId={notebook.id}
                notebookName={notebook.name}
                selectedNoteId={selectedNoteId}
                graph={graph}
                from={ctx.presentationMode}
                backHref={data.graphBack}
                view={data.graphView}
                now={data.now}
                timeZone={data.dateConfig.timeZone ?? "UTC"}
                navigationHidden={ctx.navigationHidden}
              />
            ) : selectedNote ? (
              <div class="notebook-document-surface flex flex-1 min-w-0 min-h-0 flex-col" data-full-width={ctx.fullWidth ? "" : undefined}>
                {readonlyMode && (
                  <FloatingEditButton href={currentHref} mode="readonly" locked={!!selectedNote.lockedAt} canWrite={canWrite} />
                )}
                <NoteEditor
                  noteId={selectedNote.id}
                  noteTitle={selectedNote.title}
                  notebookId={notebook.id}
                  noteLockedAt={selectedNote.lockedAt}
                  historyIncomplete={selectedNote.historyIncomplete}
                  notebookName={notebook.name}
                  appUrl={appUrl}
                  userId={user.id}
                  displayName={user.displayName}
                  initialContent={selectedNote.contentMd}
                  initialPanelOpen={detailPanelOpen}
                  initialRichMode={ctx.settings.richMode}
                  readOnly={readonlyMode}
                  initialHref={currentHref}
                  initialDetail={{
                    noteAuthors: selectedRouteState?.noteAuthors ?? { createdBy: null, lastEditedBy: null },
                    noteId: selectedNote.id,
                    noteTitle: selectedNote.title,
                    contentMd: selectedNote.contentMd,
                    createdAt: selectedNote.createdAt,
                    updatedAt: selectedNote.updatedAt,
                    lockedAt: selectedNote.lockedAt,
                    historyIncomplete: selectedNote.historyIncomplete,
                    isLocked: !!selectedNote.lockedAt,
                    tocItems,
                    taskProgress: selectedRouteState?.taskProgress ?? { done: 0, total: 0 },
                    attachments: panelAttachments,
                    backlinks,
                    namedBlocks,
                  }}
                />
                <NotePreview
                  text={selectedNote.contentMd ?? ""}
                  mode={ctx.settings.richMode}
                  historyIncomplete={selectedNote.historyIncomplete}
                />
              </div>
            ) : (
              <Placeholder
                class="flex-1"
                variant="panel"
                icon="ti ti-file-text"
                description={ctx.sidebarTree.total === 0 ? t.noNotes : t.selectNote}
              />
            )}
          </AppWorkspace.Main>

          {showDetailPanel && selectedNote && (
            <NotebookDetailPanel
              presentationMode={ctx.presentationMode}
              noteAuthors={selectedRouteState?.noteAuthors}
              mode={readonlyMode ? "read" : "edit"}
              initiallyOpen={readonlyMode ? true : detailPanelOpen}
              fullWidth={ctx.fullWidth}
              tocItems={tocItems}
              taskProgress={selectedRouteState?.taskProgress ?? { done: 0, total: 0 }}
              attachments={panelAttachments}
              backlinks={backlinks}
              namedBlocks={namedBlocks}
              currentNotebookId={notebook.id}
              notebookId={notebook.id}
              noteId={selectedNote.id}
              noteTitle={selectedNote.title}
              contentMd={selectedNote.contentMd}
              createdAt={selectedNote.createdAt}
              updatedAt={selectedNote.updatedAt}
              lockedAt={selectedNote.lockedAt}
              historyIncomplete={selectedNote.historyIncomplete}
              isLocked={!!selectedNote.lockedAt}
              canWrite={canWrite}
              currentUserId={user.id}
              initialCommentsPage={initialCommentsPage ?? undefined}
              dateConfig={dateConfig}
            />
          )}
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
});
