import { gardenNotesDe } from "./garden.de";
import type { NotebookTemplate, TemplateContext } from "./types";

const gardenDashboardScript = `// Garden dashboard
// Reads simple tables from all #garden notes and shows what matters this month.

// ── Month window helpers ────────────────────────────────────────
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const currentMonth = new Date().getMonth() + 1;
const monthLabel = monthNames[currentMonth - 1];
const monthNumber = (name) => monthNames.findIndex((item) => item.toLowerCase() === String(name).slice(0, 3).toLowerCase()) + 1;
const inRange = (value, range) => {
  const parts = String(range ?? "").split("-").map((part) => monthNumber(part.trim())).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return value === parts[0];
  const [start, end] = parts;
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
};

// ── Read source notes ───────────────────────────────────────────
const notes = await nb.search("#garden");
const plants = notes.flatMap((note) => note.table("plants")?.rows ?? []);
const beds = notes.flatMap((note) => note.table("beds")?.rows ?? []);
const harvest = notes.flatMap((note) => note.table("harvest")?.rows ?? []);
const pages = notes.filter((note) => note.id !== current.id).sort((a, b) => a.title.localeCompare(b.title));
const openTasks = current.todo("tasks")?.items.filter((item) => !item.done) ?? [];

// ── Derive this month's actions from month ranges ───────────────
const actions = plants.flatMap((plant) => {
  const rows = [];
  if (inRange(currentMonth, plant.Sow)) rows.push({ Plant: plant.Name, Action: "Sow", Window: plant.Sow, Bed: plant.Bed, Notes: plant.Notes });
  if (inRange(currentMonth, plant.Plant)) rows.push({ Plant: plant.Name, Action: "Plant out", Window: plant.Plant, Bed: plant.Bed, Notes: plant.Notes });
  if (inRange(currentMonth, plant.Harvest)) rows.push({ Plant: plant.Name, Action: "Harvest", Window: plant.Harvest, Bed: plant.Bed, Notes: plant.Notes });
  return rows;
});

const harvestByPlant = harvest.reduce((acc, row) => {
  const key = row.Plant || "Other";
  acc[key] = (acc[key] ?? 0) + Number(String(row.Amount ?? "0").replace(",", "."));
  return acc;
}, {});

const addGardenTask = async (text) => {
  await current.todo("tasks")?.add(text);
  ui.toast("Task added", { variant: "success" });
};

// ── Render dashboard ────────────────────────────────────────────
ui.render(
  ui.heading(monthLabel + " garden dashboard", 2),
  ui.row(
    ui.metric("Plants", plants.length, { icon: "ti ti-plant-2", tone: "success" }),
    ui.metric("Beds", beds.length, { icon: "ti ti-seedling", tone: "info" }),
    ui.metric("Open tasks", openTasks.length, { icon: "ti ti-checkbox", tone: "warning" }),
  ),
  ui.table(actions.map((row) => ({
    ...row,
    Action: ui.button("Add task", () => addGardenTask(row.Action + " " + row.Plant + " in " + row.Bed), {
      variant: "secondary",
      icon: "ti ti-list-plus",
    }),
  })), { emptyText: "No plant actions for this month." }),
  ui.table(openTasks.map((item) => ({
    Task: item.content,
    Action: ui.button("Done", async () => {
      await current.replaceLine(item.line, "- [x] " + item.content);
    }, { variant: "secondary", icon: "ti ti-check" }),
  })), { emptyText: "No open dashboard tasks." }),
  ui.chart("bar", {
    data: Object.entries(harvestByPlant).map(([label, value]) => ({ label, value })),
    title: "Harvest amount by plant",
    showValues: true,
    height: 180,
  }),
  ui.heading("Garden pages", 3),
  ui.noteList(pages, { emptyText: "No garden pages yet." }),
  ui.button("Add garden task", async () => {
    const text = await ui.prompt.text("Task", "", { title: "Garden task", placeholder: "Mulch Bed B" });
    if (!text) return;
    await addGardenTask(text);
  }, { icon: "ti ti-list-check" }),
);`;

export const gardenPlannerTemplate: NotebookTemplate = {
  id: "garden-planner",
  name: "Garden Log",
  description: "Planting windows, beds, harvests, and seasonal garden actions.",
  icon: "ti ti-plant-2",
  notebookName: "Garden Log",
  notebookDescription: "Plants, beds, harvests, and a script dashboard that derives what is next from simple tables.",
  translations: {
    de: {
      name: "Gartentagebuch",
      description: "Aussaatzeiten, Beete, Ernten und saisonale Gartenarbeiten.",
      notebookName: "Gartentagebuch",
      notebookDescription: "Pflanzen, Beete und Ernten mit einem Dashboard, das die nächsten Arbeiten aus einfachen Tabellen ableitet.",
    },
  },
  scriptsEnabled: true,
  homepageNoteKey: "dashboard",
  notes: (ctx: TemplateContext) =>
    ctx.locale?.toLowerCase().split("-")[0] === "de"
      ? gardenNotesDe(ctx)
      : [
          {
            key: "dashboard",
            content: (c) => `# Garden Dashboard

#garden

:::success
Start here. Keep the source tables simple; the dashboard derives the current work from the month ranges.
:::

## How to use this garden log

1. Add or edit plants in ${c.link("plants", "Plants")}. Use simple month ranges like \`Mar-Apr\`.
2. Keep bed notes and the native hedge plan in ${c.link("beds", "Beds & Native Hedge")}.
3. Record real harvests in ${c.link("harvest", "Harvest")}. The chart reads that table.
4. Add short dashboard tasks below when something needs attention this week.

:::info
The starter data is tuned for Central Europe and Franconia: robust vegetables, kitchen herbs, and native shrubs with wildlife value.
:::

\`\`\`script
${gardenDashboardScript}
\`\`\`

@tasks
- [ ] Check slug pressure after rain
- [ ] Mulch tomatoes after the soil warms
- [ ] Order two native hedge shrubs for autumn
`,
          },
          {
            key: "plants",
            content: `# Plants

#garden #plants

@plants
| Name | Type | Bed | Sow | Plant | Harvest | Notes |
|---|---|---|---|---|---|---|
| Tomato Harzfeuer | Vegetable | Bed A | Mar-Apr | May | Jul-Oct | Warm, rain-protected, airy leaves |
| Bush bean | Vegetable | Bed B | May-Jul | May-Jul | Jul-Sep | Sow only into warm soil |
| Carrot | Vegetable | Bed B | Mar-Jul |  | Jun-Nov | Loose soil, steady moisture |
| Lettuce | Vegetable | Bed C | Mar-Aug | Mar-Aug | Apr-Oct | Use half shade in hot weeks |
| Chard | Vegetable | Bed C | Apr-Jul | Apr-Jul | Jun-Nov | Reliable leaf crop |
| Kale | Vegetable | Bed D | May-Jul | Jun-Jul | Oct-Feb | Frost improves taste |
| Chives | Herb | Bed C | Mar-Apr | Mar-Apr | Mar-Nov | Leave some flowers for insects |
| Parsley | Herb | Bed C | Mar-Jul | Mar-Jul | May-Nov | Slow germination |
| Cornelian cherry | Native hedge | Hedge |  | Oct-Mar | Aug-Sep | Early nectar, edible fruit |
| Hawthorn | Native hedge | Hedge |  | Oct-Mar | Sep-Oct | Strong nesting shrub |
| Dog rose | Native hedge | Hedge |  | Oct-Mar | Sep-Feb | Rose hips and shelter |

:::info
The starter favors Central Europe and Franconia: robust vegetables, kitchen herbs, and native shrubs with wildlife value.
:::
`,
          },
          {
            key: "beds",
            content: `# Beds & Native Hedge

#garden #beds

@beds
| Bed | Sun | Soil | Main crop | Good neighbors | Notes |
|---|---|---|---|---|---|
| Bed A - Warm wall | full sun | compost-rich | Tomato | Basil, marigold | Water at soil, keep leaves dry |
| Bed B - Roots and beans | sun | loose, sandy | Carrot, bush bean | Onion, savory | Avoid fresh manure for carrots |
| Bed C - Leafy shade | half shade | humus | Lettuce, chard, herbs | Chives, radish | Good summer refuge |
| Bed D - Winter | sun | firm | Kale | Field salad, leek | Keep space for autumn |
| Hedge | mixed | native soil | Cornelian cherry, hawthorn, dog rose | Hazel, blackthorn | Plant mixed, not as a single species row |

@hedgePlan
:::data
goal: food for insects and birds
plantingWindow: October to March
style: mixed native hedge
firstStep: plant 5 shrubs in autumn
:::

:::success
A useful native hedge has staggered bloom, fruit, thorns, and structure. Do not over-prune the flowering wood.
:::
`,
          },
          {
            key: "harvest",
            content: `# Harvest

#garden #harvest

@harvest
| Date | Plant | Amount | Unit | Bed | Kitchen use | Notes |
|---|---|---:|---|---|---|---|
| ${ctx.now.getFullYear()}-05-20 | Chives | 1 | bunch | Bed C | herb quark | Leave flowers for insects |
| ${ctx.now.getFullYear()}-06-15 | Lettuce | 3 | heads | Bed C | dinner salad | Sow next row |
| ${ctx.now.getFullYear()}-07-14 | Zucchini | 1.2 | kg | Bed A | fritters | Pick smaller next time |
| ${ctx.now.getFullYear()}-08-02 | Tomato Harzfeuer | 0.8 | kg | Bed A | tomato salad | Remove lower leaves |
| ${ctx.now.getFullYear()}-08-10 | Bush bean | 0.6 | kg | Bed B | beans with savory | Second picking planned |
| ${ctx.now.getFullYear()}-09-18 | Carrot | 1.4 | kg | Bed B | soup | Good size after rain |

@uses
| Ingredient | Best use | Preserve |
|---|---|---|
| Tomato | salad, sauce, Brotzeit | cook down |
| Chives | herb quark, potatoes | freeze cut |
| Cornelian cherry | jam, chutney | cook down |
| Rose hip | tea, syrup | dry or cook |
`,
          },
        ],
};
