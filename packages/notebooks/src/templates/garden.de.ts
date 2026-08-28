import type { TemplateContext, TemplateNote } from "./types";

const gardenDashboardScriptDe = `// Gartenübersicht
// Liest die Tabellen aller #garden-Notizen und zeigt die Arbeiten des aktuellen Monats.
const monthNames = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const monthLabels = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const currentMonth = new Date().getMonth() + 1;
const monthLabel = monthLabels[currentMonth - 1];
const monthNumber = (name) => monthNames.findIndex((item) => item.toLowerCase() === String(name).slice(0, 3).toLowerCase()) + 1;
const inRange = (value, range) => {
  const parts = String(range ?? "").split("-").map((part) => monthNumber(part.trim())).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return value === parts[0];
  const [start, end] = parts;
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
};

const notes = await nb.search("#garden");
const plants = notes.flatMap((note) => note.table("plants")?.rows ?? []);
const beds = notes.flatMap((note) => note.table("beds")?.rows ?? []);
const harvest = notes.flatMap((note) => note.table("harvest")?.rows ?? []);
const pages = notes.filter((note) => note.id !== current.id).sort((a, b) => a.title.localeCompare(b.title));
const openTasks = current.todo("tasks")?.items.filter((item) => !item.done) ?? [];

const actions = plants.flatMap((plant) => {
  const rows = [];
  if (inRange(currentMonth, plant.Sow)) rows.push({ Pflanze: plant.Name, Arbeit: "Aussäen", Zeitraum: plant.Sow, Beet: plant.Bed, Hinweise: plant.Notes });
  if (inRange(currentMonth, plant.Plant)) rows.push({ Pflanze: plant.Name, Arbeit: "Auspflanzen", Zeitraum: plant.Plant, Beet: plant.Bed, Hinweise: plant.Notes });
  if (inRange(currentMonth, plant.Harvest)) rows.push({ Pflanze: plant.Name, Arbeit: "Ernten", Zeitraum: plant.Harvest, Beet: plant.Bed, Hinweise: plant.Notes });
  return rows;
});

const harvestByPlant = harvest.reduce((acc, row) => {
  const key = row.Plant || "Sonstiges";
  acc[key] = (acc[key] ?? 0) + Number(String(row.Amount ?? "0").replace(",", "."));
  return acc;
}, {});

const addGardenTask = async (text) => {
  await current.todo("tasks")?.add(text);
  ui.toast("Aufgabe hinzugefügt", { variant: "success" });
};

ui.render(
  ui.heading("Gartenübersicht für " + monthLabel, 2),
  ui.row(
    ui.metric("Pflanzen", plants.length, { icon: "ti ti-plant-2", tone: "success" }),
    ui.metric("Beete", beds.length, { icon: "ti ti-seedling", tone: "info" }),
    ui.metric("Offene Aufgaben", openTasks.length, { icon: "ti ti-checkbox", tone: "warning" }),
  ),
  ui.table(actions.map((row) => ({
    ...row,
    Aktion: ui.button("Aufgabe hinzufügen", () => addGardenTask(row.Arbeit + " – " + row.Pflanze + " in " + row.Beet), {
      variant: "secondary", icon: "ti ti-list-plus",
    }),
  })), { emptyText: "Für diesen Monat stehen keine Pflanzenarbeiten an." }),
  ui.table(openTasks.map((item) => ({
    Aufgabe: item.content,
    Aktion: ui.button("Erledigt", async () => {
      await current.replaceLine(item.line, "- [x] " + item.content);
    }, { variant: "secondary", icon: "ti ti-check" }),
  })), { emptyText: "Keine offenen Aufgaben in der Übersicht." }),
  ui.chart("bar", {
    data: Object.entries(harvestByPlant).map(([label, value]) => ({ label, value })),
    title: "Erntemenge nach Pflanze", showValues: true, height: 180,
  }),
  ui.heading("Gartenseiten", 3),
  ui.noteList(pages, { emptyText: "Noch keine Gartenseiten vorhanden." }),
  ui.button("Gartenaufgabe hinzufügen", async () => {
    const text = await ui.prompt.text("Aufgabe", "", { title: "Gartenaufgabe", placeholder: "Beet B mulchen" });
    if (!text) return;
    await addGardenTask(text);
  }, { icon: "ti ti-list-check" }),
);`;

export const gardenNotesDe = (ctx: TemplateContext): TemplateNote[] => [
  {
    key: "dashboard",
    content: (c) => `# Gartenübersicht

#garden

:::success
Beginne hier. Halte die Ausgangstabellen übersichtlich; die Gartenübersicht leitet die aktuellen Arbeiten aus den Monatszeiträumen ab.
:::

## So verwendest du dieses Gartentagebuch

1. Ergänze oder bearbeite Pflanzen unter ${c.link("plants", "Pflanzen")}. Verwende Monatszeiträume wie »Mär-Apr«.
2. Halte Beetnotizen und den Plan für die heimische Hecke unter ${c.link("beds", "Beete und heimische Hecke")} fest.
3. Trage tatsächliche Ernten unter ${c.link("harvest", "Ernte")} ein. Das Diagramm wertet diese Tabelle aus.
4. Ergänze unten kurze Aufgaben, wenn in dieser Woche etwas ansteht.

:::info
Die Beispieldaten sind auf Mitteleuropa und Franken ausgerichtet: robuste Gemüsesorten, Küchenkräuter und heimische Sträucher mit Nutzen für Wildtiere.
:::

\`\`\`script
${gardenDashboardScriptDe}
\`\`\`

@tasks
- [ ] Nach Regen den Schneckendruck prüfen
- [ ] Tomaten mulchen, sobald der Boden warm ist
- [ ] Zwei heimische Heckensträucher für den Herbst bestellen
`,
  },
  {
    key: "plants",
    content: `# Pflanzen

#garden #plants

@plants
| Name | Type | Bed | Sow | Plant | Harvest | Notes |
|---|---|---|---|---|---|---|
| Tomate Harzfeuer | Gemüse | Beet A | Mär-Apr | Mai | Jul-Okt | Warm, regengeschützt, Blätter luftig halten |
| Buschbohne | Gemüse | Beet B | Mai-Jul | Mai-Jul | Jul-Sep | Nur in warmen Boden säen |
| Karotte | Gemüse | Beet B | Mär-Jul |  | Jun-Nov | Lockerer Boden und gleichmäßige Feuchtigkeit |
| Kopfsalat | Gemüse | Beet C | Mär-Aug | Mär-Aug | Apr-Okt | In heißen Wochen halbschattig anbauen |
| Mangold | Gemüse | Beet C | Apr-Jul | Apr-Jul | Jun-Nov | Verlässliches Blattgemüse |
| Grünkohl | Gemüse | Beet D | Mai-Jul | Jun-Jul | Okt-Feb | Frost verbessert den Geschmack |
| Schnittlauch | Kraut | Beet C | Mär-Apr | Mär-Apr | Mär-Nov | Einige Blüten für Insekten stehen lassen |
| Petersilie | Kraut | Beet C | Mär-Jul | Mär-Jul | Mai-Nov | Keimt langsam |
| Kornelkirsche | Heimische Hecke | Hecke |  | Okt-Mär | Aug-Sep | Früher Nektar und essbare Früchte |
| Weißdorn | Heimische Hecke | Hecke |  | Okt-Mär | Sep-Okt | Dichtes Nistgehölz |
| Hundsrose | Heimische Hecke | Hecke |  | Okt-Mär | Sep-Feb | Hagebutten und Deckung |

:::info
Die Auswahl bevorzugt robuste Gemüsesorten, Küchenkräuter und heimische Sträucher für Mitteleuropa und Franken.
:::
`,
  },
  {
    key: "beds",
    content: `# Beete und heimische Hecke

#garden #beds

@beds
| Bed | Sun | Soil | Main crop | Good neighbors | Notes |
|---|---|---|---|---|---|
| Beet A – Warme Wand | volle Sonne | kompostreich | Tomate | Basilikum, Studentenblume | Bodennah gießen, Blätter trocken halten |
| Beet B – Wurzeln und Bohnen | Sonne | locker, sandig | Karotte, Buschbohne | Zwiebel, Bohnenkraut | Keine frische Gülle für Karotten |
| Beet C – Blattschatten | Halbschatten | humos | Salat, Mangold, Kräuter | Schnittlauch, Radieschen | Guter Rückzugsort im Sommer |
| Beet D – Winter | Sonne | fest | Grünkohl | Feldsalat, Lauch | Platz für den Herbst lassen |
| Hecke | gemischt | heimischer Boden | Kornelkirsche, Weißdorn, Hundsrose | Hasel, Schlehe | Gemischt pflanzen, nicht als Reihe einer Art |

@hedgePlan
:::data
goal: Nahrung für Insekten und Vögel
plantingWindow: Oktober bis März
style: gemischte heimische Hecke
firstStep: im Herbst 5 Sträucher pflanzen
:::

:::success
Eine wertvolle heimische Hecke bietet zeitlich gestaffelte Blüten, Früchte, Dornen und Struktur. Blühendes Holz nicht zu stark zurückschneiden.
:::
`,
  },
  {
    key: "harvest",
    content: `# Ernte

#garden #harvest

@harvest
| Date | Plant | Amount | Unit | Bed | Kitchen use | Notes |
|---|---|---:|---|---|---|---|
| ${ctx.now.getFullYear()}-05-20 | Schnittlauch | 1 | Bund | Beet C | Kräuterquark | Blüten für Insekten stehen lassen |
| ${ctx.now.getFullYear()}-06-15 | Kopfsalat | 3 | Köpfe | Beet C | Abendsalat | Nächste Reihe aussäen |
| ${ctx.now.getFullYear()}-07-14 | Zucchini | 1.2 | kg | Beet A | Puffer | Künftig kleiner ernten |
| ${ctx.now.getFullYear()}-08-02 | Tomate Harzfeuer | 0.8 | kg | Beet A | Tomatensalat | Untere Blätter entfernen |
| ${ctx.now.getFullYear()}-08-10 | Buschbohne | 0.6 | kg | Beet B | Bohnen mit Bohnenkraut | Zweite Ernte geplant |
| ${ctx.now.getFullYear()}-09-18 | Karotte | 1.4 | kg | Beet B | Suppe | Gute Größe nach dem Regen |

@uses
| Ingredient | Best use | Preserve |
|---|---|---|
| Tomate | Salat, Soße, Brotzeit | einkochen |
| Schnittlauch | Kräuterquark, Kartoffeln | geschnitten einfrieren |
| Kornelkirsche | Marmelade, Chutney | einkochen |
| Hagebutte | Tee, Sirup | trocknen oder einkochen |
`,
  },
];
