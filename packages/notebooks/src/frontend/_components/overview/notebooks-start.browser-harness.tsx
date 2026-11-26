import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { openNewNotebookDialog } from "../../create-notebook-dialog";
import type { TemplateSummary } from "./NewNotebookDialog";
import NotebooksStart from "./NotebooksStart";

// Test harness only (never shipped). `?data=` picks the templates: the demo pair (default), `worst` (the longest real
// built-in names and descriptions in both languages plus a plausible longer one from a future language), `empty` (no
// template at all) or `one`; `?lang=en` renders in English.
const demo: TemplateSummary[] = [
  { id: "meeting", name: "Besprechungen", description: "Protokolle mit Aufgaben und Beschlüssen", icon: "ti ti-users" },
  { id: "handbook", name: "Handbuch", description: "Kapitel, Abläufe und Ansprechpersonen", icon: "ti ti-book" },
];
const worst: TemplateSummary[] = [
  {
    id: "recipes",
    name: "Rezepte und Vorräte",
    description: "Rezepte, Vorratsbestand, Einkaufsliste und Anregungen für den Einstieg.",
    icon: "ti ti-chef-hat",
  },
  {
    id: "daily",
    name: "Tagebuch",
    description: "Tägliche Notizen, Posteingang, Gewohnheiten, Aufgaben und Wochenrückblicke.",
    icon: "ti ti-calendar",
  },
  {
    id: "handover",
    name: "Projektdokumentation und Übergabeprotokolle für Schichtwechsel 🛠️",
    description:
      "Projektübersicht, Übergaben je Schicht, offene Punkte, Ansprechpersonen, Störungsverlauf und Lessons Learned – 引き継ぎ記録",
    icon: "ti ti-clipboard-list",
  },
  { id: "j", name: "J", description: "", icon: "ti ti-notebook" },
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
          <NotebooksStart templates={templates} />
        </LocaleProvider>
      ),
      root,
    );
}
