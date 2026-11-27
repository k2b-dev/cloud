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
          ["Camembert", "250", "g"],
          ["Frischkäse", "200", "g"],
          ["Zwiebel", "1,2", "kg"],
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
        columns: ["Titel", "Autor", "Status"],
        rows: [
          ["Momo", "Michael Ende", "Liest du"],
          ["Unterleuten", "Juli Zeh", "Gelesen"],
          ["Der Process", "Franz Kafka", "Als Nächstes"],
        ],
      },
    },
    onOpen: () => undefined,
  },
];

const GRIDS = "#0d9488";
const bases: Tile[] = [
  { icon: "plus", title: "Leere Base", meta: "Eine leere Tabelle", color: GRIDS, preview: { icon: "table" }, onOpen: () => undefined },
  {
    icon: "wallet",
    title: "Private Finanzen",
    meta: "5 Tabellen",
    color: GRIDS,
    preview: {
      table: {
        columns: ["Datum", "Text", { label: "Betrag", align: "end" }],
        rows: [
          ["03.11.", "Miete", "−980,00"],
          ["05.11.", "Gehalt", "2.640,00"],
          ["08.11.", "Strom", "−64,20"],
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
        columns: ["Nr.", "Kunde", { label: "Betrag", align: "end" }],
        rows: [
          ["041", "Brandt", "1.240,00"],
          ["042", "Oswald", "380,00"],
          ["043", "Lindqvist", "96,00"],
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
      </Pane>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  grids: () => <FirstStart app="Grids" line="Leg deine erste Base an" tiles={bases} />,
};
