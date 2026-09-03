import { Button, LocaleProvider, Pagination, Placeholder, TextInput } from "@k2b/ui";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { buildNoteUrl, buildTagPageUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { bookMessages } from "./messages";

export type BookTagContentProps = {
  notebookId: string;
  tag: string;
  search: string;
  page: number;
  items: Array<{ shortId: string; title: string; updatedAt: string; preview: string | null }>;
  total: number;
  totalNotesForTag: number;
  locale: string;
};

/** Shared server output for initial pages and authorized Book snapshots. */
export default function BookTagContent(props: BookTagContentProps) {
  const t = notebookWorkspaceMessages.resolve([props.locale]).t;
  const labels = bookMessages.resolve([props.locale]).t;
  const baseHref = buildTagPageUrl(props.notebookId, props.tag);
  const query = new URLSearchParams({ mode: "book" });
  if (props.search) query.set("search", props.search);
  const formatDate = (iso: string) => new Intl.DateTimeFormat(props.locale).format(new Date(iso));
  return (
    <LocaleProvider locale={props.locale}>
      <section class="flex flex-col gap-4">
        <h1 class="text-xl font-semibold">#{props.tag}</h1>
        <form role="search" method="get" action={baseHref} class="flex gap-2">
          <input type="hidden" name="mode" value="book" />
          <TextInput
            name="search"
            type="search"
            value={props.search}
            icon="ti ti-search"
            placeholder={t.searchTaggedNotes({ tag: props.tag })}
            aria-label={t.searchTaggedNotesLabel({ tag: props.tag })}
          />
          <Button type="submit" variant="secondary">
            {labels.search}
          </Button>
        </form>
        <span class="text-xs text-dimmed tabular-nums">
          {props.search
            ? t.filteredCount({ shown: props.total, total: props.totalNotesForTag })
            : t.noteCount({ count: props.totalNotesForTag })}
        </span>
        {props.items.length ? (
          <ul class="flex flex-col gap-1">
            {props.items.map((note) => (
              <li>
                <a
                  href={withPresentationMode(buildNoteUrl(props.notebookId, note.shortId), "book")}
                  class="flex flex-col gap-1 rounded-[var(--ui-radius-control)] px-3 py-2.5 no-underline hover:bg-[var(--ui-hover)]"
                >
                  <div class="flex items-center gap-2">
                    <i class="ti ti-file-text text-sm shrink-0 text-dimmed" />
                    <span class="flex-1 truncate text-sm text-primary">{note.title}</span>
                    <span class="shrink-0 text-xs text-dimmed tabular-nums">{formatDate(note.updatedAt)}</span>
                  </div>
                  {note.preview && <p class="text-xs text-dimmed line-clamp-2 pl-5">{note.preview}</p>}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder
            surface="paper"
            icon="ti ti-search-off"
            description={
              props.search ? t.noTaggedSearchResults({ tag: props.tag, query: props.search }) : t.noTaggedNotes({ tag: props.tag })
            }
          />
        )}
        <Pagination currentPage={props.page} totalPages={Math.max(1, Math.ceil(props.total / 50))} baseUrl={`${baseHref}?${query}&page=`} />
      </section>
    </LocaleProvider>
  );
}
