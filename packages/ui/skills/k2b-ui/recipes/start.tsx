// Recipe: the first start of an app that has no data yet (the first notebook, the first base). No sidebar and no
// switcher: one line in the middle of the page and four cards, the blank way first, each with a preview of what it
// makes. A card opens the dialog that makes it.
import { Pane, Text, type Tile, Tiles, Workspace } from "@k2b/ui/v2";

/** Notebooks' colour; an app passes its own (`var(--k2-app)` inside a Cloud page). */
const APP = "#ca8a04";

const notebooks: Tile[] = [
  {
    icon: "plus",
    title: "Leeres Notizbuch",
    meta: "1 Seite",
    color: APP,
    preview: { page: { title: "Willkommen!", text: "Deine erste Notiz. Schreib los, Markdown geht auch." } },
    onOpen: () => undefined,
  },
  {
    icon: "calendar-stats",
    title: "Tagebuch",
    meta: "6 Seiten",
    color: APP,
    preview: { page: { title: "Tagebuch", text: "Beginne hier. Schreibe täglich eine kurze Notiz." } },
    onOpen: () => undefined,
  },
  {
    icon: "tools-kitchen-2",
    title: "Rezepte und Vorräte",
    meta: "6 Seiten",
    color: APP,
    preview: {
      table: {
        columns: ["Zutat", { label: "Menge", align: "end" }, "Einheit"],
        rows: [
          ["Zwiebel", "1,2", "kg"],
          ["Eier", "8", "Stück"],
          ["Mehl", "1,5", "kg"],
        ],
      },
    },
    onOpen: () => undefined,
  },
  {
    icon: "books",
    title: "Leseliste",
    meta: "4 Seiten",
    color: APP,
    preview: {
      table: {
        columns: ["Titel", "Status"],
        rows: [
          ["Momo", "Lese ich"],
          ["Faust", "Gelesen"],
          ["Altes Land", "Gelesen"],
        ],
      },
    },
    onOpen: () => undefined,
  },
];

const GRIDS = "#0d9488";
const bases: Tile[] = [
  { icon: "plus", title: "Leere Base", meta: "Noch ohne Tabellen", color: GRIDS, preview: { icon: "table" }, onOpen: () => undefined },
  {
    icon: "wallet",
    title: "Private Finanzen",
    meta: "5 Tabellen",
    color: GRIDS,
    preview: {
      table: {
        columns: ["Datum", { label: "Betrag", align: "end" }, "Text"],
        rows: [
          ["03.11.", "−980,00", "Miete"],
          ["05.11.", "2.640,00", "Gehalt"],
          ["08.11.", "−64,20", "Strom"],
        ],
      },
    },
    onOpen: () => undefined,
  },
  {
    icon: "box",
    title: "Inventar",
    meta: "6 Tabellen",
    color: GRIDS,
    preview: {
      table: {
        columns: ["Ding", "Ort", "Status"],
        rows: [
          ["Kamera", "Regal 2", "Verliehen"],
          ["Mikrofon", "Regal 1", "Da"],
          ["Stativ", "Kiste 4", "Da"],
        ],
      },
    },
    onOpen: () => undefined,
  },
  {
    icon: "receipt",
    title: "Rechnungswesen",
    meta: "3 Tabellen",
    color: GRIDS,
    preview: {
      table: {
        columns: ["Nr.", { label: "Betrag", align: "end" }, "Kunde"],
        rows: [
          ["041", "1.240,00", "Brandt"],
          ["042", "380,00", "Oswald"],
          ["043", "96,00", "Lindqvist"],
        ],
      },
    },
    onOpen: () => undefined,
  },
];

type Props = { app: string; line: string; tiles: readonly Tile[] };

// `grids`: the same first start in Grids, with the tables its templates make and a sign for the blank base.
export default function FirstStart(props: Partial<Props>) {
  return (
    <Workspace>
      <Pane label={props.app ?? "Notizbücher"} center>
        <Text type="lead">{props.line ?? "Leg dein erstes Notizbuch an"}</Text>
        <Tiles variant="card" perRow={4} label="Wege zum Start" items={props.tiles ?? notebooks} />
        {/* the templates that have no card stay reachable: the dialog that makes it offers them all */}
        <Text type="meta" muted>
          Weitere Vorlagen stehen beim Anlegen zur Wahl.
        </Text>
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  grids: () => <FirstStart app="Grids" line="Leg deine erste Base an" tiles={bases} />,
};
