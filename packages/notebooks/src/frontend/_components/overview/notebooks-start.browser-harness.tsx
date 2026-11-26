import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import NotebooksStart from "./NotebooksStart";

const root = document.getElementById("root");
if (root) {
  document.documentElement.lang = "de";
  render(
    () => (
      <LocaleProvider locale="de">
        <NotebooksStart
          templates={[
            { id: "meeting", name: "Besprechungen", description: "Protokolle mit Aufgaben und Beschlüssen", icon: "ti ti-users" },
            { id: "handbook", name: "Handbuch", description: "Kapitel, Abläufe und Ansprechpersonen", icon: "ti ti-book" },
          ]}
        />
      </LocaleProvider>
    ),
    root,
  );
}
