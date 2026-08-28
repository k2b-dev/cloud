import { AppWorkspace, Placeholder } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import NotebookDetailPanel from "./_components/detail/NotebookDetailPanel.island";
import NoteEditor from "./_components/editor/NoteEditor.client";
import NotebookGraph from "./_components/graph/NotebookGraph.island";
import NotebookHotkeys from "./_components/shortcuts/NotebookHotkeys.island";
import NotebookNavigatorPane from "./_components/sidebar/NotebookNavigatorPane.island";
import NotebookSidebar from "./_components/sidebar/NotebookSidebar.island";
import WorkspaceEventBridge from "./_components/sidebar/WorkspaceEventBridge.island";
import VersionHistory from "./_components/versions/VersionHistory.island";
import { loadNotebookPageData } from "./page-data";
import { notebooksPageMessages } from "../messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = notebooksPageMessages.resolve([getLocale(c)]);
  const data = await loadNotebookPageData(c);

  if (data.kind === "not_found") {
    return () => (
      <Layout c={c} title={t.notFound}>
        <div class="max-w-md mx-auto mt-16">
          <Placeholder surface="paper" state="error" icon="ti ti-alert-circle" title={t.notebookNotFound} />
        </div>
      </Layout>
    );
  }

  if (data.kind === "access_denied") {
    return () => (
      <Layout c={c} title={t.accessDenied}>
        <div class="max-w-md mx-auto mt-16">
          <Placeholder
            surface="paper"
            state="error"
            icon="ti ti-lock"
            title={t.accessDenied}
            description={t.accessDeniedDescription}
          />
        </div>
      </Layout>
    );
  }

  if (data.kind === "redirect") return c.redirect(data.href);

  const {
    user,
    notebook,
    tree,
    isVersionsMode,
    isGraphMode,
    canWrite,
    canRunScripts,
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
    dateConfig,
  } = data;
  const editorOwnsWorkspaceSocket = !!selectedNote && !isVersionsMode && !isGraphMode && !readonlyMode;
  return () => (
    <Layout
      c={c}
      fullPage
      title={[
        { title: t.start, href: "/" },
        { title: t.notebooks, href: "/app/notebooks" },
        { title: notebook.name, href: `/app/notebooks/${notebook.id}` },
        ...(selectedNote ? [{ title: selectedNote.title }] : []),
      ]}
    >
      <AppWorkspace class="flex-1 min-h-0">
        <NotebookHotkeys notebookId={notebook.id} notebookName={notebook.name} canWrite={canWrite} />
        {!editorOwnsWorkspaceSocket && (
          <WorkspaceEventBridge notebookId={notebook.id} appUrl={appUrl} initialCursor={ctx.workspaceCursor} />
        )}

        <NotebookSidebar ctx={ctx} />

        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            {ctx.settings.sidebarMode === "navigator" && (
              <AppWorkspace.MainPane
                id="notebook-notes"
                label={t.noteList}
                surface="navigation"
                defaultSize={336}
                minSize={280}
                maxSize={520}
                scroll={false}
              >
                <NotebookNavigatorPane ctx={ctx} />
              </AppWorkspace.MainPane>
            )}
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
            ) : isGraphMode && graph ? (
              <NotebookGraph notebookId={notebook.id} selectedNoteId={selectedNoteId} graph={graph} />
            ) : selectedNote ? (
              <NoteEditor
                noteId={selectedNote.id}
                noteTitle={selectedNote.title}
                notebookId={notebook.id}
                scriptsEnabled={canRunScripts}
                noteCreatedAt={selectedNote.createdAt}
                noteUpdatedAt={selectedNote.updatedAt}
                noteLockedAt={selectedNote.lockedAt}
                noteParentId={selectedNote.parentId}
                notebookName={notebook.name}
                appUrl={appUrl}
                workspaceCursor={ctx.workspaceCursor}
                userId={user.id}
                displayName={user.displayName}
                initialSnapshot={selectedNote.yjsSnapshot}
                initialContent={selectedNote.contentMd}
                initialPanelOpen={detailPanelOpen}
                initialRichMode={ctx.settings.richMode}
                readOnly={readonlyMode}
                initialHref={currentHref}
                initialDetail={{
                  noteId: selectedNote.id,
                  noteTitle: selectedNote.title,
                  contentMd: selectedNote.contentMd,
                  createdAt: selectedNote.createdAt,
                  updatedAt: selectedNote.updatedAt,
                  lockedAt: selectedNote.lockedAt,
                  isLocked: !!selectedNote.lockedAt,
                  tocItems,
                  taskProgress: selectedRouteState?.taskProgress ?? { done: 0, total: 0 },
                  attachments: panelAttachments,
                  backlinks,
                  namedBlocks,
                }}
              />
            ) : (
              <Placeholder
                class="flex-1"
                icon="ti ti-file-text"
                description={tree.length === 0 ? t.noNotes : t.selectNote}
              />
            )}
          </AppWorkspace.Main>

          {showDetailPanel && selectedNote && (
            <NotebookDetailPanel
              mode={readonlyMode ? "read" : "edit"}
              initiallyOpen={readonlyMode ? true : detailPanelOpen}
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
              isLocked={!!selectedNote.lockedAt}
              dateConfig={dateConfig}
            />
          )}
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
});
