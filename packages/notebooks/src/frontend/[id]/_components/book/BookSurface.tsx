import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import BookNavigator, { type BookNavigatorProps } from "./BookNavigator.island";
import { bookMessages } from "./messages";
import PresentationModeLinks from "./PresentationModeLinks.island";
import BookMermaid from "./BookMermaid.island";

export type BookSurfaceProps = BookNavigatorProps & {
  html: string | null;
  noteTitle: string | null;
  currentHref: string;
  canWrite: boolean;
  locked: boolean;
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
              <span class="text-sm text-dimmed truncate">{props.notebookName}</span>
              {props.canWrite && <PresentationModeLinks href={props.currentHref} mode="book" locked={props.locked} />}
            </header>
            {props.html !== null ? (
              <>
                <article
                  id="notebook-book-content"
                  aria-label={props.noteTitle ?? undefined}
                  class="notebook-book-content"
                  innerHTML={props.html}
                />
                {props.html.includes('class="notebook-book-mermaid"') && <BookMermaid rootId="notebook-book-content" />}
              </>
            ) : (
              <Placeholder icon="ti ti-book" description={props.tree.length ? t().selectNote : t().empty} />
            )}
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </div>
  );
}
