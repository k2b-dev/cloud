import type { TemplateNote } from "./types";

const recipeContentDe = (title: string, type: string, time: string, servings: number, rows: string, method: string) => `# ${title}

#recipe #bavarian

@recipe
:::data
type: ${type}
servings: ${servings}
time: ${time}
source: Bayerische Hausküche
:::

:::toc
min-depth: 2
:::

@ingredients
| Zutat | Menge | Einheit | Notizen |
|---|---:|---|---|
${rows}

@shopping
- [ ] Fehlende Zutaten hier ergänzen

## Zubereitung

${method}
`;

export const recipeNotesDe = (): TemplateNote[] => [
  {
    key: "dashboard",
    content: (c) => `# Küchenübersicht

#kitchen

:::success
Beginne hier. Wähle ein Rezept im automatischen Verzeichnis und vergleiche seine Zutaten vor dem Einkauf mit deinen Vorräten.
:::

## So verwendest du dieses Küchennotizbuch

1. Trage unter ${c.link("pantry", "Vorräte")} ein, was zu Hause vorhanden ist.
2. Halte die Tabelle »@ingredients« in jedem Rezept einheitlich und übersichtlich.
3. Ergänze fehlende Zutaten in der Einkaufsliste unten.
4. Lege eine eigene Rezeptseite an, wenn du Notizen oder Arbeitsschritte für ein Gericht benötigst.

:::info
Einheitliche Zutatennamen helfen beim Vergleichen. Verwende in Rezept und Vorrat denselben Namen, zum Beispiel »Bergkäse«.
:::

:::query
source: notes
scope: notebook
where:
  - field: $tags
    op: contains
    value: recipe
sort:
  field: $title
  direction: asc
columns:
  - $title
  - recipe.type
  - recipe.servings
  - recipe.time
limit: 25
:::

@shopping
- [ ] Frische Brezn zum Obazda kaufen
- [ ] Vor den Käsespätzle den Käsevorrat prüfen
`,
  },
  {
    key: "pantry",
    content: `# Vorräte

#pantry

@pantry
| Zutat | Menge | Einheit | Nachkaufen ab | Typische Verwendung |
|---|---:|---|---:|---|
| Camembert | 250 | g | 150 | Obazda |
| Frischkäse | 200 | g | 100 | Obazda, Dips |
| Zwiebel | 1.2 | kg | 0.5 | Soßen, Salate, Obazda |
| Paprikapulver, edelsüß | 35 | g | 10 | Obazda |
| Brezn | 0 | Stück | 4 | Brotzeit |
| Eier | 8 | Stück | 4 | Spätzle |
| Mehl | 1.5 | kg | 0.5 | Spätzle, Backen |
| Bergkäse | 150 | g | 250 | Käsespätzle |
| Emmentaler | 250 | g | 200 | Käsespätzle |
| Fränkische Bratwürste | 0 | Paar | 4 | Blaue Zipfel |
| Fränkischer Weißwein | 1 | Flasche | 1 | Blaue Zipfel |
| Weißweinessig | 700 | ml | 250 | Blaue Zipfel, Salate |
| Lorbeerblätter | 12 | Blätter | 5 | Brühe und Braten |

:::info
Aktualisiere die Mengen nach dem Einkauf und Kochen. Vergleiche die Tabelle beim Planen einer Mahlzeit mit den Rezeptzutaten.
:::
`,
  },
  {
    key: "recipes",
    content: `# Rezepte

#recipes

:::query
source: notes
scope: notebook
where:
  - field: $tags
    op: contains
    value: recipe
sort:
  field: $title
  direction: asc
columns:
  - $title
  - recipe.type
  - recipe.servings
  - recipe.time
limit: 25
:::

## Aufbau eines Rezepts

- Die Daten unter »@recipe« enthalten die Metadaten.
- Die Tabelle »@ingredients« enthält Zutaten und Mengen.
- In der Aufgabenliste »@shopping« notierst du fehlende Zutaten.
`,
  },
  {
    key: "obazda",
    content: recipeContentDe(
      "Obazda mit Radi und Brezn",
      "brotzeit",
      "15 min",
      4,
      `| Camembert | 250 | g | reif, zimmerwarm |
| Frischkäse | 80 | g | alternativ weiche Butter |
| Zwiebel | 0.2 | kg | fein gewürfelt, spät zugeben |
| Paprikapulver, edelsüß | 1 | TL | zusätzlich Pfeffer und Salz |
| Brezn | 8 | Stück | frisch kaufen |
| Radi | 1 | Stück | optional, aber klassisch |`,
      `1. Camembert und Frischkäse cremig zerdrücken.
2. Mit Paprika, Pfeffer, Salz und nach Wunsch einem kleinen Schuss Bier abschmecken.
3. Die Zwiebeln erst kurz vor dem Servieren unterheben, damit sie nicht bitter werden.
4. Mit Brezn, Radi, Schnittlauch und einem kühlen Bier servieren.`,
    ),
  },
  {
    key: "kaesespaetzle",
    content: recipeContentDe(
      "Käsespätzle mit Röstzwiebeln",
      "Hauptgericht",
      "50 min",
      4,
      `| Mehl | 400 | g | Weizenmehl 405 oder Spätzlemehl |
| Eier | 5 | Stück | mittelgroß |
| Bergkäse | 250 | g | würziger Käse |
| Emmentaler | 150 | g | gut schmelzender Käse |
| Zwiebel | 0.5 | kg | dünn schneiden |
| Butter | 60 | g | für Zwiebeln und Pfanne |`,
      `1. Mehl, Eier, Salz und etwas Wasser schlagen, bis der Teig Blasen wirft.
2. In siedendes Salzwasser pressen und herausheben, sobald die Spätzle oben schwimmen.
3. Zwiebeln langsam in Butter bräunen.
4. Heiße Spätzle mit geriebenem Käse schichten, kurz abdecken und mit den Zwiebeln servieren.`,
    ),
  },
  {
    key: "blaue-zipfel",
    content: recipeContentDe(
      "Fränkische Blaue Zipfel",
      "Hauptgericht",
      "45 min",
      4,
      `| Fränkische Bratwürste | 4 | Paar | roh, frisch |
| Zwiebel | 0.7 | kg | in Scheiben |
| Fränkischer Weißwein | 500 | ml | Silvaner passt gut |
| Weißweinessig | 500 | ml | milder Essig |
| Lorbeerblätter | 2 | Blätter | mit Pfefferkörnern und Nelken |
| Karotte | 2 | Stück | geviertelt |`,
      `1. Wein, Essig, Wasser, Zwiebeln, Karotten, Lorbeer, Pfeffer und Nelken 15 Minuten köcheln lassen.
2. Die Hitze reduzieren, sodass die Flüssigkeit nicht mehr kocht.
3. Bratwürste zugeben und 15 bis 20 Minuten sanft ziehen lassen.
4. Mit Zwiebeln, Sud, Roggenbrot und Meerrettich in tiefen Tellern servieren.`,
    ),
  },
];
