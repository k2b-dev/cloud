import type { TemplateContext, TemplateNote } from "./types";

export const gardenNotesDe = (ctx: TemplateContext): TemplateNote[] => [
  {
    key: "dashboard",
    content: (c) => `# Gartenübersicht

#garden

:::success
Beginne hier. Halte Pflanzzeiten, Beetpläne und Ernten in lesbaren Tabellen fest. Das Verzeichnis unten verlinkt deine Gartenseiten.
:::

## So verwendest du dieses Gartentagebuch

1. Ergänze oder bearbeite Pflanzen unter ${c.link("plants", "Pflanzen")}. Verwende Monatszeiträume wie »Mär-Apr«.
2. Halte Beetnotizen und den Plan für die heimische Hecke unter ${c.link("beds", "Beete und heimische Hecke")} fest.
3. Trage tatsächliche Ernten unter ${c.link("harvest", "Ernte")} ein.
4. Ergänze unten kurze Aufgaben, wenn in dieser Woche etwas ansteht.

:::info
Die Beispieldaten sind auf Mitteleuropa und Franken ausgerichtet: robuste Gemüsesorten, Küchenkräuter und heimische Sträucher mit Nutzen für Wildtiere.
:::

:::query
source: notes
scope: notebook
where:
  - field: $tags
    op: contains
    value: garden
sort:
  field: $title
  direction: asc
limit: 25
:::

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
| Name | Typ | Beet | Aussaat | Pflanzung | Ernte | Notizen |
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
| Beet | Sonne | Boden | Hauptkultur | Gute Nachbarn | Notizen |
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
| Datum | Pflanze | Menge | Einheit | Beet | Verwendung | Notizen |
|---|---|---:|---|---|---|---|
| ${ctx.now.getFullYear()}-05-20 | Schnittlauch | 1 | Bund | Beet C | Kräuterquark | Blüten für Insekten stehen lassen |
| ${ctx.now.getFullYear()}-06-15 | Kopfsalat | 3 | Köpfe | Beet C | Abendsalat | Nächste Reihe aussäen |
| ${ctx.now.getFullYear()}-07-14 | Zucchini | 1.2 | kg | Beet A | Puffer | Künftig kleiner ernten |
| ${ctx.now.getFullYear()}-08-02 | Tomate Harzfeuer | 0.8 | kg | Beet A | Tomatensalat | Untere Blätter entfernen |
| ${ctx.now.getFullYear()}-08-10 | Buschbohne | 0.6 | kg | Beet B | Bohnen mit Bohnenkraut | Zweite Ernte geplant |
| ${ctx.now.getFullYear()}-09-18 | Karotte | 1.4 | kg | Beet B | Suppe | Gute Größe nach dem Regen |

@uses
| Zutat | Verwendung | Haltbar machen |
|---|---|---|
| Tomate | Salat, Soße, Brotzeit | einkochen |
| Schnittlauch | Kräuterquark, Kartoffeln | geschnitten einfrieren |
| Kornelkirsche | Marmelade, Chutney | einkochen |
| Hagebutte | Tee, Sirup | trocknen oder einkochen |
`,
  },
];
