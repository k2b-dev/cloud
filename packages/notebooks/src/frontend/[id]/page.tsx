import { getLiveDictationStatus } from "@k2b/cloud/ai";
import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { AppWorkspace } from "@k2b/ui";
import { ssr } from "../../config";
import { katexStylesHref } from "../../lib/katex-assets";
import { notebooksPageMessages } from "../messages";
import { buildNoteUrl } from "../params";
import BookGraphSurface from "./_components/book/BookGraphSurface";
import BookSurface from "./_components/book/BookSurface";
import NotebookGraph from "./_components/graph/NotebookGraph.island";
import NotebookCommands from "./_components/NotebookCommands.island";
import NoteWorkspace from "./_components/NoteWorkspace.island";
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
          navigation={data.bookNavigation}
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
          navigation={data.bookNavigation}
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
          openComments={data.bookOpenComments}
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
    relations,
    accessVisible,
    initialCommentsPage,
    initialAnnotations,
    dateConfig,
  } = data;
  const showsEditorToolbar = !!selectedNote && !isVersionsMode && !isGraphMode && !readonlyMode;
  // The microphone shows only where dictation can start: a live model is set up and this person may use it.
  const liveDictation = showsEditorToolbar && (await getLiveDictationStatus(c.get("accessSubject"))).available;
  const title = [
    { title: t.start, href: "/" },
    { title: t.notebooks },
    // Version history and the graph carry their own way back to the note, so the shell adds none there.
    { title: notebook.name, ...(isVersionsMode || isGraphMode ? {} : { href: `/app/notebooks/${notebook.id}` }) },
    ...(selectedNote ? [{ title: selectedNote.title }] : []),
  ];
  if (!isVersionsMode && !isGraphMode)
    return () => (
      <Layout
        context={{ scope: { type: "notebooks.notebook", id: data.notebook.id } }}
        printHint={t.printHint}
        c={c}
        fullPage
        fullWidth
        ui="v2"
        title={title}
      >
        <link rel="stylesheet" href={katexStylesHref} />
        <RememberNotebook notebookId={notebook.id} />
        <NotebookCommands notebookId={notebook.id} notebookName={notebook.name} canWrite={canWrite} ownsSearchNavigation={!selectedNote} />
        {/* Live changes reach the page through one workspace socket; a note connects its own only while it is edited. */}
        <WorkspaceEventBridge
          notebookId={notebook.id}
          appUrl={appUrl}
          initialCursor={ctx.workspaceCursor}
          initialNoteId={selectedNote?.id ?? null}
        />
        <NoteWorkspace
          ctx={ctx}
          mode={readonlyMode ? "read" : "edit"}
          canEdit={canWrite && !selectedNote?.lockedAt}
          emptyText={ctx.sidebarTree.total === 0 ? t.noNotes : t.selectNote}
          note={
            selectedNote
              ? {
                  editor: {
                    noteId: selectedNote.id,
                    noteTitle: selectedNote.title,
                    notebookId: notebook.id,
                    noteLockedAt: selectedNote.lockedAt,
                    historyIncomplete: selectedNote.historyIncomplete,
                    notebookName: notebook.name,
                    appUrl,
                    userId: user.id,
                    displayName: user.displayName,
                    initialContent: selectedNote.contentMd,
                    initialPanelOpen: detailPanelOpen,
                    initialRichMode: ctx.settings.richMode,
                    readOnly: readonlyMode,
                    canWrite,
                    liveDictation,
                    initialAnnotations,
                    initialHref: currentHref,
                    initialDetail: {
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
                      relations,
                      namedBlocks,
                    },
                  },
                  preview: {
                    text: selectedNote.contentMd ?? "",
                    annotations: initialAnnotations ?? null,
                    me: user.id,
                    mode: ctx.settings.richMode,
                    historyIncomplete: selectedNote.historyIncomplete,
                  },
                  details: showDetailPanel
                    ? {
                        presentationMode: ctx.presentationMode,
                        noteAuthors: selectedRouteState?.noteAuthors,
                        mode: readonlyMode ? "read" : "edit",
                        initiallyOpen: readonlyMode ? true : detailPanelOpen,
                        fullWidth: ctx.fullWidth,
                        tocItems,
                        taskProgress: selectedRouteState?.taskProgress ?? { done: 0, total: 0 },
                        attachments: panelAttachments,
                        backlinks,
                        relations,
                        accessVisible,
                        canManageAccess: data.permission === "admin",
                        namedBlocks,
                        currentNotebookId: notebook.id,
                        notebookId: notebook.id,
                        noteId: selectedNote.id,
                        noteTitle: selectedNote.title,
                        contentMd: selectedNote.contentMd,
                        createdAt: selectedNote.createdAt,
                        updatedAt: selectedNote.updatedAt,
                        lockedAt: selectedNote.lockedAt,
                        historyIncomplete: selectedNote.historyIncomplete,
                        isLocked: !!selectedNote.lockedAt,
                        canWrite,
                        currentUserId: user.id,
                        initialCommentsPage: initialCommentsPage ?? undefined,
                        dateConfig,
                        now: new Date().toISOString(),
                      }
                    : null,
                }
              : null
          }
        />
      </Layout>
    );
  return () => (
    <Layout
      context={{ scope: { type: "notebooks.notebook", id: data.notebook.id } }}
      printHint={t.printHint}
      c={c}
      fullPage
      title={[
        { title: t.start, href: "/" },
        { title: t.notebooks, href: "/app/notebooks" },
        // Version history and the graph carry their own way back to the note, so the shell adds none there.
        { title: notebook.name, ...(isVersionsMode || isGraphMode ? {} : { href: `/app/notebooks/${notebook.id}` }) },
        ...(selectedNote ? [{ title: selectedNote.title }] : []),
      ]}
    >
      <link rel="stylesheet" href={katexStylesHref} />
      <RememberNotebook notebookId={notebook.id} />
      {/* Write and Links draw no workspace head: their toolbar holds the navigation and Details buttons, and the note's
          title is in the navigation. Read and version history have no toolbar and keep the head's buttons. */}
      <AppWorkspace
        mobileSurface="flush"
        class="notebooks-workspace flex-1 min-h-0"
        head={showsEditorToolbar || isGraphMode ? false : undefined}
      >
        <NotebookCommands
          notebookId={notebook.id}
          notebookName={notebook.name}
          canWrite={canWrite}
          ownsSearchNavigation={!selectedNote || isVersionsMode || isGraphMode}
        />
        {/* Live changes reach the page through one workspace socket; a note connects its own only while it is edited. */}
        <WorkspaceEventBridge
          notebookId={notebook.id}
          appUrl={appUrl}
          initialCursor={ctx.workspaceCursor}
          initialNoteId={!isVersionsMode && !isGraphMode ? selectedNote?.id : null}
        />

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
              />
            ) : null}
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
});
