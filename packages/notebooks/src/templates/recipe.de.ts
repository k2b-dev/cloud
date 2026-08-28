import type { TemplateNote } from "./types";

const recipeDashboardScriptDe = `// Küchenübersicht
const normalize = (value) => String(value ?? "").trim().toLowerCase();
const numberValue = (value) => Number(String(value ?? "0").replace(",", ".")) || 0;

const recipeNotes = await nb.search("#recipe");
const pantryNote = (await nb.search("#pantry"))[0];
const pantryRows = pantryNote?.table("pantry")?.rows ?? [];
const pantry = new Map(pantryRows.map((row) => [normalize(row.Item), numberValue(row.Amount)]));

const recipeRows = recipeNotes
  .filter((note) => note.table("ingredients"))
  .map((note) => {
    const ingredients = note.table("ingredients")?.rows ?? [];
    const meta = note.data("recipe")?.value ?? {};
    const missing = ingredients.filter((row) => !pantry.has(normalize(row.Item)) || pantry.get(normalize(row.Item)) <= 0);
    return {
      Rezept: note,
      Art: meta.type ?? "Rezept",
      Zeit: meta.time ?? "",
      "Vorratsabgleich": "=PROGRESS(" + (ingredients.length - missing.length) + ", " + ingredients.length + ")",
      Fehlend: missing.map((row) => row.Item).join(", "),
      missingItems: missing.map((row) => row.Item),
    };
  })
  .sort((a, b) => a.missingItems.length - b.missingItems.length);
const pages = [pantryNote, ...recipeNotes].filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
const shoppingItems = current.todo("shopping")?.items ?? [];
const openShopping = shoppingItems.filter((item) => !item.done);

const addShoppingItems = async (items) => {
  await current.todo("shopping")?.add(...items);
  ui.toast("Zur Einkaufsliste hinzugefügt", { variant: "success" });
};

const recipeTableRows = recipeRows.map((row) => ({
  Rezept: row.Rezept,
  Art: row.Art,
  Zeit: row.Zeit,
  "Vorratsabgleich": row["Vorratsabgleich"],
  Fehlend: row.Fehlend,
  Aktion: row.missingItems.length
    ? ui.button("Einkaufen", () => addShoppingItems(row.missingItems.map((item) => item + " für " + row.Rezept.title)), {
        variant: "secondary", icon: "ti ti-shopping-cart-plus",
      })
    : "",
}));

const shoppingRows = shoppingItems.map((item) => ({
  Eintrag: item.content,
  Status: item.done ? "erledigt" : "offen",
  Aktion: item.done ? "" : ui.button("Erledigt", async () => {
    await current.replaceLine(item.line, "- [x] " + item.content);
  }, { variant: "secondary", icon: "ti ti-check" }),
}));

ui.render(
  ui.heading("Küchenübersicht", 2),
  ui.row(
    ui.metric("Rezepte", recipeRows.length, { icon: "ti ti-chef-hat", tone: "success" }),
    ui.metric("Vorräte", pantryRows.length, { icon: "ti ti-basket", tone: "info" }),
    ui.metric("Einkauf", openShopping.length, { icon: "ti ti-shopping-cart", tone: "warning" }),
  ),
  ui.table(recipeTableRows, { emptyText: "Noch keine Rezeptnotizen vorhanden." }),
  ui.chart("bar", {
    data: recipeRows.map((row) => ({ label: row.Rezept.title, value: row.missingItems.length })),
    title: "Fehlende Vorräte", showValues: true, height: 180,
  }),
  ui.table(shoppingRows, { emptyText: "Die Einkaufsliste ist leer." }),
  ui.heading("Küchenseiten", 3),
  ui.noteList(pages, { emptyText: "Noch keine Küchenseiten vorhanden." }),
  ui.button("Fehlende Zutaten ergänzen", async () => {
    const best = recipeRows.find((row) => row.missingItems.length > 0);
    if (!best) {
      ui.toast("Alle Beispielrezepte passen zum Vorrat", { variant: "success" });
      return;
    }
    await addShoppingItems(best.missingItems.map((item) => item + " für " + best.Rezept.title));
  }, { icon: "ti ti-shopping-cart-plus" }),
);`;

const recipesIndexScriptDe = `// Rezeptverzeichnis
const recipeNotes = (await nb.search("#recipe"))
  .filter((note) => note.table("ingredients"))
  .sort((a, b) => a.title.localeCompare(b.title));

ui.render(
  ui.heading("Rezeptübersicht", 2),
  ui.table(recipeNotes.map((note) => {
    const meta = note.data("recipe")?.value ?? {};
    return {
      Rezept: note,
      Art: meta.type ?? "Rezept",
      Zeit: meta.time ?? "",
      Zutaten: note.table("ingredients")?.rows.length ?? 0,
    };
  }), { emptyText: "Noch keine Rezeptnotizen vorhanden." }),
);`;

const recipeReadinessScriptDe = `// Vorratsabgleich für dieses Rezept
const normalize = (value) => String(value ?? "").trim().toLowerCase();
const numberValue = (value) => Number(String(value ?? "0").replace(",", ".")) || 0;

const pantryNote = (await nb.search("#pantry"))[0];
const pantryRows = pantryNote?.table("pantry")?.rows ?? [];
const pantry = new Map(pantryRows.map((row) => [normalize(row.Item), numberValue(row.Amount)]));

const ingredients = current.table("ingredients")?.rows ?? [];
const rows = ingredients.map((row) => {
  const onHand = pantry.get(normalize(row.Item)) ?? 0;
  const missing = onHand <= 0;
  return {
    Zutat: row.Item,
    Benötigt: row.Amount + " " + row.Unit,
    Vorrat: missing ? "fehlt" : "vorhanden",
    Hinweise: row.Notes,
    Aktion: missing ? ui.button("Hinzufügen", async () => {
      await current.todo("shopping")?.add(row.Item + " für " + current.title);
      ui.toast("Zur Einkaufsliste hinzugefügt", { variant: "success" });
    }, { variant: "secondary", icon: "ti ti-shopping-cart-plus" }) : "",
  };
});
const missing = rows.filter((row) => row.Vorrat !== "vorhanden").map((row) => row.Zutat);

ui.render(
  ui.heading("Vorratsabgleich", 3),
  ui.table(rows),
  ui.chart("donut", {
    data: [
      { label: "Vorhanden", value: rows.length - missing.length },
      { label: "Fehlt", value: missing.length },
    ],
    showLabels: true, height: 150,
  }),
  ui.button("Fehlende Zutaten hier ergänzen", async () => {
    if (missing.length === 0) return;
    await current.todo("shopping")?.add(...missing.map((item) => item + " für " + current.title));
    ui.toast("Fehlende Zutaten hinzugefügt", { variant: "success" });
  }, { icon: "ti ti-shopping-cart-plus" }),
);`;

const recipeContentDe = (title: string, type: string, time: string, servings: number, rows: string, method: string) => `# ${title}

#recipe #bavarian

@recipe
:::data
type: ${type}
servings: ${servings}
time: ${time}
source: Bayerische Hausküche
:::

\`\`\`script
${recipeReadinessScriptDe}
\`\`\`

@ingredients
| Item | Amount | Unit | Notes |
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
Beginne hier. Die Übersicht vergleicht die Zutaten der Rezepte mit deinen Vorräten und zeigt, was du bald kochen kannst.
:::

## So verwendest du dieses Küchennotizbuch

1. Trage unter ${c.link("pantry", "Vorräte")} ein, was zu Hause vorhanden ist.
2. Halte die Tabelle »@ingredients« in jedem Rezept einheitlich und übersichtlich.
3. Wähle **Fehlende Zutaten ergänzen**, um aus dem passendsten Rezept eine kurze Einkaufsliste zu erstellen.
4. Lege eine eigene Rezeptseite an, wenn du Notizen, Arbeitsschritte oder einen Vorratsabgleich für ein Gericht benötigst.

:::info
Zutatennamen dienen als Suchschlüssel. Verwende in Rezept und Vorrat denselben Namen, zum Beispiel »Bergkäse«.
:::

\`\`\`script
${recipeDashboardScriptDe}
\`\`\`

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
| Item | Amount | Unit | Reorder at | Typical use |
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
Die erste Spalte ist der Suchschlüssel für die Scripts. Einheitliche Namen sorgen für einen verlässlichen Abgleich.
:::
`,
  },
  {
    key: "recipes",
    content: `# Rezepte

#recipes

\`\`\`script
${recipesIndexScriptDe}
\`\`\`

## Aufbau eines Rezepts

- Die Daten unter »@recipe« enthalten die Metadaten.
- Die Tabelle »@ingredients« steuert den Vorratsabgleich.
- Die Aufgabenliste »@shopping« nimmt fehlende Zutaten auf.
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
