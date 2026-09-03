import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import WorkspaceEventBridge from "../sidebar/WorkspaceEventBridge.island";
import BookController from "./BookController.island";
import BookMermaid from "./BookMermaid.island";
import BookNavigator, { type BookNavigatorProps } from "./BookNavigator.island";
import { bookMessages } from "./messages";
import PresentationModeLinks from "./PresentationModeLinks.island";

export type BookSurfaceProps = BookNavigatorProps & {
  html: string | null;
  noteTitle: string | null;
  currentHref: string;
  canWrite: boolean;
  locked: boolean;
  appUrl: string;
  cursor: string | null;
};

export default function BookSurface(props: BookSurfaceProps) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  return (
    <div class="k2b-ui notebook-book-shell">
      <AppWorkspace class="notebook-book-workspace">
        <BookNavigator
          notebookId={props.notebookId}
          notebookName={props.notebookName}
          selectedNoteId={props.selectedNoteId}
          tree={props.tree}
          tags={props.tags}
          activeTag={props.activeTag}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="notebook-book-main">
            <header class="notebook-book-header">
              <span id="notebook-book-name" class="text-sm text-dimmed truncate">
                {props.notebookName}
              </span>
              <PresentationModeLinks href={props.currentHref} mode="book" locked={props.locked} canWrite={props.canWrite} />
            </header>
            <BookController
              notebookId={props.notebookId}
              initial={{
                href: props.currentHref,
                title: props.noteTitle,
                notebookName: props.notebookName,
                selectedNoteId: props.selectedNoteId,
                tree: props.tree,
                tags: props.tags,
                activeTag: props.activeTag,
                canWrite: props.canWrite,
                locked: props.locked,
                cursor: props.cursor,
              }}
            />
            <WorkspaceEventBridge notebookId={props.notebookId} appUrl={props.appUrl} initialCursor={props.cursor} />
            {props.html !== null ? (
              <article
                id="notebook-book-content"
                aria-label={props.noteTitle ?? undefined}
                tabIndex={-1}
                class="notebook-book-content"
                innerHTML={props.html}
              />
            ) : (
              <article id="notebook-book-content" class="notebook-book-content" tabIndex={-1}>
                <Placeholder icon="ti ti-book" description={props.tree.length ? t().selectNote : t().empty} />
              </article>
            )}
            <BookMermaid rootId="notebook-book-content" />
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}
