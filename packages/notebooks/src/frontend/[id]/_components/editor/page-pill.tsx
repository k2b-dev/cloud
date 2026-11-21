import { Button, IconButtonLink, Tooltip, useLocale } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import { ariaShortcut } from "../../../lib/shortcut-label";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { bookMessages } from "../book/messages";
import { commentMessages } from "../comments/messages";
import { DetailsButton, NavigationButton } from "./workspace-buttons";

type PagePillProps = {
  notebookId: string;
  noteId: string;
  /** The note's open comments: the button shows their number and opens them. */
  comments?: { open: number; onOpen: () => void };
  /** Leads the pill, such as the reconnecting state while writing. */
  status?: JSX.Element;
  /** Leads the actions in Read, where no formatting pill holds the navigation and the way into Write. */
  read?: { canEdit: boolean };
};

/**
 * The note's page pill (K6): a note has neither head nor status row, so its views and actions float in this pill at
 * the bottom of the text, in Write beside the formatting pill and in Read on its own. Read and Write lead it as each
 * other's way back; the Detail's "View" menu keeps every view and the text options.
 */
export function PagePill(props: PagePillProps) {
  const locale = useLocale();
  const book = () => bookMessages.resolve([locale()]).t;
  const comment = () => commentMessages.resolve([locale()]).t;
  return (
    <div
      class="k2b-pill notebooks-editor-pill notebooks-editor-pill--page"
      role="group"
      aria-label={notebookWorkspaceMessages.resolve([locale()]).t.noteActionsLabel}
    >
      {props.status}
      {/* The way between Write and Read stands first: Read in Write, the pencil in Read. */}
      <Show when={!props.read}>
        <Tooltip.Anchor content={notebookWorkspaceMessages.resolve([locale()]).t.openAsRead}>
          <IconButtonLink
            href={buildNoteUrl(props.notebookId, props.noteId, "readonly")}
            label={notebookWorkspaceMessages.resolve([locale()]).t.openAsRead}
            tooltip={false}
            size="xs"
            class="text-dimmed"
          >
            <i class="ti ti-eye" aria-hidden="true" />
          </IconButtonLink>
        </Tooltip.Anchor>
      </Show>
      <Show when={props.read}>
        {(read) => (
          <>
            <NavigationButton />
            <Show when={read().canEdit}>
              <Tooltip.Anchor content={book().editNote}>
                <IconButtonLink
                  href={buildNoteUrl(props.notebookId, props.noteId, "write")}
                  label={book().editNote}
                  tooltip={false}
                  size="xs"
                  class="text-dimmed"
                >
                  <i class="ti ti-pencil" aria-hidden="true" />
                </IconButtonLink>
              </Tooltip.Anchor>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.comments}>
        {(comments) => (
          <Tooltip.Anchor content={comment().commentsShortcut}>
            <Button
              size="xs"
              variant="ghost"
              class="text-dimmed notebook-comments-button"
              aria-label={comment().commentsButton({ count: comments().open })}
              aria-keyshortcuts={ariaShortcut("Mod-Alt-m")}
              onClick={() => comments().onOpen()}
            >
              <i class="ti ti-message-circle text-sm" aria-hidden="true" />
              <Show when={comments().open}>
                <span class="tabular-nums font-semibold">{comments().open}</span>
              </Show>
            </Button>
          </Tooltip.Anchor>
        )}
      </Show>
      <Tooltip.Anchor content={book().openBook}>
        <IconButtonLink
          href={buildNoteUrl(props.notebookId, props.noteId, "book")}
          label={book().openBook}
          tooltip={false}
          size="xs"
          class="text-dimmed"
        >
          <i class="ti ti-book" aria-hidden="true" />
        </IconButtonLink>
      </Tooltip.Anchor>
      <DetailsButton />
    </div>
  );
}

/** Read has no formatting pill: the page pill stands alone in the row the writing pills use. */
export function ReadingPills(props: Omit<PagePillProps, "read" | "status"> & { canEdit: boolean }) {
  return (
    <div class="notebooks-editor-toolbar text-base text-dimmed">
      <PagePill notebookId={props.notebookId} noteId={props.noteId} comments={props.comments} read={{ canEdit: props.canEdit }} />
    </div>
  );
}
