import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import NotebooksHome from "./NotebooksHome";
import { activity, activityPage, HOME_NOW, notebooks, recentNotes } from "./notebooks-home.fixtures";

/** `<html data-state>`: `empty`, `many` (200 notebooks, long names), `activity1000`, `failed` (no activity read). */
const state = document.documentElement.dataset.state ?? "normal";
const root = document.getElementById("root");
if (root) {
  document.documentElement.lang = "de";
  const books = state === "empty" ? [] : notebooks(state === "many");
  const all = state === "empty" ? [] : activity(state === "activity1000" ? 1000 : 75);
  render(
    () => (
      <LocaleProvider locale="de">
        <NotebooksHome
          notebooks={books}
          templates={[
            { id: "meeting", name: "Besprechungen", description: "Protokolle mit Aufgaben und Beschlüssen", icon: "ti ti-users" },
            { id: "handbook", name: "Handbuch", description: "Kapitel, Abläufe und Ansprechpersonen", icon: "ti ti-book" },
          ]}
          recentNotes={state === "empty" ? [] : recentNotes}
          initialActivity={state === "failed" ? { items: [], nextCursor: null } : activityPage(all, 0)}
          initialActivityFailed={state === "failed"}
          initialPinnedNotebookIds={state === "empty" ? [] : state === "many" ? ["book00", "book07", "book014"] : ["book01"]}
          dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }}
          now={HOME_NOW}
        />
      </LocaleProvider>
    ),
    root,
  );
}
