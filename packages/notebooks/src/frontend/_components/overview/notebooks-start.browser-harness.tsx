import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { openNewNotebookDialog } from "../../create-notebook-dialog";
import NotebooksStart, { type StartPage, type StartTemplate } from "./NotebooksStart";

// Test harness only (never shipped). `?data=` picks the templates: the demo pair (default), `worst` (the longest real
// built-in names and descriptions in both languages plus a plausible longer one from a future language, with Japanese,
// Arabic and Vietnamese pages, an address and a one-letter template without pages), `empty` (no
// template at all) or `one`; `?lang=en` renders in English.
const pages = (...titles: string[]): StartPage[] =>
  titles.map((title) => {
    const [parent, own] = title.includes(" › ") ? title.split(" › ") : [null, title];
    return { title: own ?? title, parent };
  });
const demo: StartTemplate[] = [
  {
    id: "meeting",
    name: "Besprechungen",
    description: "Protokolle mit Aufgaben und Beschlüssen",
    icon: "ti ti-users",
    pages: pages("Besprechungen", "Offene Aufgaben", "Beschlüsse", "2027", "2027 › KW 02 Teamrunde", "2027 › KW 04 Teamrunde"),
  },
  {
    id: "handbook",
    name: "Handbuch",
    description: "Kapitel, Abläufe und Ansprechpersonen",
    icon: "ti ti-book",
    pages: pages("Handbuch", "Wareneingang", "Wareneingang › Annahme prüfen", "Versand", "Ansprechpersonen"),
  },
];
const blankPages = pages("Welcome!");
const worst: StartTemplate[] = [
  {
    id: "recipes",
    name: "Rezepte und Vorräte",
    description: "Rezepte, Vorratsbestand, Einkaufsliste und Anregungen für den Einstieg.",
    icon: "ti ti-chef-hat",
    pages: pages("Rezepte und Vorräte", "Rezepte", "Vorrat", "Einkaufsliste"),
  },
  {
    id: "daily",
    name: "Tagebuch",
    description: "Tägliche Notizen, Posteingang, Gewohnheiten, Aufgaben und Wochenrückblicke.",
    icon: "ti ti-calendar",
    pages: pages(
      "Tagebuch",
      "Eingang",
      "2026",
      ...Array.from(
        { length: 60 },
        (_, day) => `2026 › 2026-11-${String((day % 30) + 1).padStart(2, "0")} Übergabe- und Störungsprotokoll der Frühschicht Halle 7`,
      ),
    ),
  },
  {
    id: "handover",
    name: "Projektdokumentation und Übergabeprotokolle für Schichtwechsel 🛠️",
    description:
      "Projektübersicht, Übergaben je Schicht, offene Punkte, Ansprechpersonen, Störungsverlauf und Lessons Learned – 引き継ぎ記録",
    icon: "ti ti-clipboard-list",
    pages: pages(
      "Projektdokumentation",
      "引き継ぎ記録 🛠️",
      "سجل التسليم › ملاحظات الوردية الصباحية",
      "Biên bản bàn giao ca sáng › Danh sách việc còn tồn đọng",
      "https://intranet.nordwerk-instandhaltung.example.com/wiki/uebergabe/halle-7/fruehschicht",
    ),
  },
  { id: "j", name: "J", description: "", icon: "ti ti-notebook", pages: [] },
];
const url = new URL(window.location.href);
const data = url.searchParams.get("data");
const templates = data === "worst" ? worst : data === "empty" ? [] : data === "one" ? demo.slice(0, 1) : demo;
const lang = url.searchParams.get("lang") === "en" ? "en" : "de";

const root = document.getElementById("root");
if (root) {
  document.documentElement.lang = lang;
  if (url.searchParams.has("switcher"))
    // a notebook page that is not v2 yet: its switcher opens the same dialog in a v2 scope of its own
    render(
      () => (
        <button type="button" onClick={() => void openNewNotebookDialog({ kind: "template" }, lang)}>
          Notizbuch aus Vorlage
        </button>
      ),
      root,
    );
  else
    render(
      () => (
        <LocaleProvider locale={lang}>
          <NotebooksStart templates={templates} blankPages={blankPages} open={url.searchParams.get("template")} />
        </LocaleProvider>
      ),
      root,
    );
}
