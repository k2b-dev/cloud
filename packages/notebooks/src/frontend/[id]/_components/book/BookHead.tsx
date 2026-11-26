import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Avatar, Bar, Button, type Person, Tabs, Text } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { NotebookActivityActor } from "../../../../lib/activity-actions";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { notebookWorkspaceMessages } from "../../messages";
import { commentMessages } from "../comments/messages";
import NoteViewMenu from "../NoteViewMenu";
import { commentsHref } from "./book-comments";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export type BookHeadProps = {
  notebookId: string;
  /** The server's full-width cookie value, so the first frame matches. */
  fullWidth: boolean;
  /** The note the page opened with; later notes arrive as snapshots without a new page. */
  initial: BookMetadata;
  /** The server's time: the base of "vor 4 Min" for the first note, so server and browser say the same. */
  now: string;
};

const person = (actor: NotebookActivityActor): Person => ({
  name: actor.displayName,
  image:
    actor.kind === "user" && actor.id && actor.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(actor.id)}/avatar?rev=${encodeURIComponent(actor.avatarHash)}`
      : undefined,
});

/**
 * Book's head, one row: the note's views (Bearbeiten, Lesen, Buch) for writers, then who wrote the note and who changed
 * it last and when, and at the end the view menu and the note's open comments. The notebook is named once: by the
 * sidebar's switcher, and on the phone by the shell's title row. The note's own title is the article's first heading,
 * the page's hero. The reader moves between notes without a new page, so the head follows each note's snapshot.
 */
export default function BookHead(props: BookHeadProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const book = () => bookMessages.resolve([locale()]).t;
  const comments = () => commentMessages.resolve([locale()]).t;
  const [shown, setShown] = createSignal(props.initial);
  onMount(() => {
    const onBook = (event: Event) => setShown((event as CustomEvent<BookMetadata>).detail);
    window.addEventListener(BOOK_SNAPSHOT_EVENT, onBook);
    onCleanup(() => window.removeEventListener(BOOK_SNAPSHOT_EVENT, onBook));
  });
  // Write and Read keep the address's query (the navigation's filters) and only switch the mode.
  const workspaceHref = (mode: "write" | "readonly") =>
    withPresentationMode(shown().selectedNoteId ? shown().href : `/app/notebooks/${props.notebookId}`, mode);
  const openComments = () => (shown().selectedNoteId ? (shown().openComments ?? 0) : 0);
  const entry = () => comments().bookEntry({ count: openComments() });
  // the people of the note: who changed it last, then who wrote it (once each)
  const people = () => {
    const authors = shown().selectedNoteId ? shown().authors : null;
    const actors = [authors?.lastEditedBy, authors?.createdBy].filter((actor): actor is NotebookActivityActor => !!actor);
    return actors
      .filter((actor, index) => actors.findIndex((other) => other.kind === actor.kind && other.id === actor.id) === index)
      .map(person);
  };
  // "zuletzt Lena Hartwig · vor 4 Min": the first note counts from the server's time, a later one from the browser's
  const lastChanged = () => {
    const editor = shown().selectedNoteId ? shown().authors?.lastEditedBy : null;
    const updatedAt = shown().updatedAt;
    if (!editor || !updatedAt) return null;
    const base = shown() === props.initial ? props.now : new Date().toISOString();
    return book().lastChanged({ name: editor.displayName, when: dates.formatDateTimeRelative(updatedAt, { base, locale: locale() }) });
  };

  return (
    <Bar
      start={
        // Readers stay in Book: only writers get the way into the workspace, as the note's head offers it.
        // k2b-ui gap: the notebook's name in the head while the sidebar is hidden (Workspace collapse state, lane Z2);
        // the switcher names it while the sidebar shows, the shell's title row on the phone.
        <>
          <Show when={shown().canWrite}>
            <Tabs
              label={t().view}
              items={[
                ...(shown().selectedNoteId && !shown().locked
                  ? [{ label: t().openAsEdit, icon: "pencil", href: workspaceHref("write") }]
                  : []),
                { label: t().openAsRead, icon: "eye", href: workspaceHref("readonly") },
                { label: book().book, icon: "book", current: true, href: withPresentationMode(shown().href, "book") },
              ]}
            />
          </Show>
          {/* the note's people, one quiet line (rule: people are visible); cut first when the head is narrow */}
          <Show when={people().length > 0}>
            <Avatar.Stack
              people={people()}
              label={book().authors({
                names: people()
                  .map((one) => one.name)
                  .join(", "),
              })}
            />
          </Show>
          <Show when={lastChanged()}>{(line) => <Text type="meta">{line()}</Text>}</Show>
        </>
      }
      end={
        <>
          <NoteViewMenu
            mode="read"
            fullWidth={props.fullWidth}
            initialRich
            host={() => document.querySelector(".notebook-book-document")}
          />
          {/* the note's open comments: their sign and number, named in words; Read opens at the first of them */}
          <Show when={openComments() > 0}>
            <Button icon="message-circle" label={entry()} title={entry()} href={commentsHref(shown().href)} keep>
              {String(openComments())}
            </Button>
          </Show>
        </>
      }
    />
  );
}
