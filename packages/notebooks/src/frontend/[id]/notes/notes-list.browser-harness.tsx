import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import NotesListScreen from "./NotesListScreen";
import { filterNotes, NOTES_NOW, notesContext, sampleNotes, tagsOf, worstNotes } from "./notes-list.fixture";
import { NOTES_PER_PAGE, notesQuery, parseNotesAddress } from "./query";

/**
 * The notes list for a browser test, rendered as the server would render it for the page's address: the address is
 * parsed with the same declaration and the sample is filtered like the service does. `data-sample` picks the notes
 * (`normal`, `worst`, `huge` with 1,200 notes) and `data-permission` the person's access.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const sample = document.documentElement.dataset.sample ?? "normal";
const permission = document.documentElement.dataset.permission === "read" ? "read" : "write";
const all = sample === "worst" ? worstNotes() : sample === "huge" ? sampleNotes(1200) : sampleNotes();
const favorites = all.filter((_, index) => index % 2 === 0).map((note) => note.shortId);
const params = new URLSearchParams(location.search);
const address = parseNotesAddress(notesQuery("de", tagsOf(all)), params);
const { items, total } = filterNotes(all, address.state, address.page, favorites);
const mode = params.get("mode") === "book" ? "book" : undefined;

render(
  () => (
    <LocaleProvider locale="de">
      <NotesListScreen
        ctx={notesContext(all, permission)}
        state={address.state}
        page={address.page}
        pages={Math.max(1, Math.ceil(total / NOTES_PER_PAGE))}
        total={total}
        items={items}
        ignored={null}
        mode={mode}
        graphBack={`${location.pathname}${location.search}`}
        now={NOTES_NOW}
      />
    </LocaleProvider>
  ),
  host,
);
