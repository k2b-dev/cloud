import type { NotebookTemplate } from "./types";

const recipeDashboardScript = `// Kitchen dashboard
// Compares every #recipe ingredient table with the pantry table.

const normalize = (value) => String(value ?? "").trim().toLowerCase();
const numberValue = (value) => Number(String(value ?? "0").replace(",", ".")) || 0;

// ── Read source notes ───────────────────────────────────────────
const recipeNotes = await nb.search("#recipe");
const pantryNote = (await nb.search("#pantry"))[0];
const pantryRows = pantryNote?.table("pantry")?.rows ?? [];
const pantry = new Map(pantryRows.map((row) => [normalize(row.Item), numberValue(row.Amount)]));

// ── Derive recipe readiness ─────────────────────────────────────
const recipeRows = recipeNotes
  .filter((note) => note.table("ingredients"))
  .map((note) => {
    const ingredients = note.table("ingredients")?.rows ?? [];
    const meta = note.data("recipe")?.value ?? {};
    const missing = ingredients.filter((row) => !pantry.has(normalize(row.Item)) || pantry.get(normalize(row.Item)) <= 0);
    return {
      Recipe: note,
      Type: meta.type ?? "recipe",
      Time: meta.time ?? "",
      "Pantry match": "=PROGRESS(" + (ingredients.length - missing.length) + ", " + ingredients.length + ")",
      Missing: missing.map((row) => row.Item).join(", "),
      missingItems: missing.map((row) => row.Item),
    };
  })
  .sort((a, b) => a.missingItems.length - b.missingItems.length);
const pages = [pantryNote, ...recipeNotes].filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
const shoppingItems = current.todo("shopping")?.items ?? [];
const openShopping = shoppingItems.filter((item) => !item.done);

const addShoppingItems = async (items) => {
  await current.todo("shopping")?.add(...items);
  ui.toast("Shopping items added", { variant: "success" });
};

const recipeTableRows = recipeRows.map((row) => ({
  Recipe: row.Recipe,
  Type: row.Type,
  Time: row.Time,
  "Pantry match": row["Pantry match"],
  Missing: row.Missing,
  Action: row.missingItems.length
    ? ui.button("Shop", () => addShoppingItems(row.missingItems.map((item) => item + " for " + row.Recipe.title)), {
        variant: "secondary",
        icon: "ti ti-shopping-cart-plus",
      })
    : "",
}));

const shoppingRows = shoppingItems.map((item) => ({
  Item: item.content,
  Done: item.done ? "yes" : "open",
  Action: item.done ? "" : ui.button("Done", async () => {
    await current.replaceLine(item.line, "- [x] " + item.content);
  }, { variant: "secondary", icon: "ti ti-check" }),
}));

// ── Render dashboard ────────────────────────────────────────────
ui.render(
  ui.heading("Kitchen dashboard", 2),
  ui.row(
    ui.metric("Recipes", recipeRows.length, { icon: "ti ti-chef-hat", tone: "success" }),
    ui.metric("Pantry items", pantryRows.length, { icon: "ti ti-basket", tone: "info" }),
    ui.metric("Shopping", openShopping.length, { icon: "ti ti-shopping-cart", tone: "warning" }),
  ),
  ui.table(recipeTableRows, { emptyText: "No recipe notes yet." }),
  ui.chart("bar", {
    data: recipeRows.map((row) => ({ label: row.Recipe.title, value: row.missingItems.length })),
    title: "Missing pantry items",
    showValues: true,
    height: 180,
  }),
  ui.table(shoppingRows, { emptyText: "Shopping list is empty." }),
  ui.heading("Kitchen pages", 3),
  ui.noteList(pages, { emptyText: "No kitchen pages yet." }),
  ui.button("Add best missing items", async () => {
    const best = recipeRows.find((row) => row.missingItems.length > 0);
    if (!best) {
      ui.toast("All starter recipes match the pantry", { variant: "success" });
      return;
    }
    await addShoppingItems(best.missingItems.map((item) => item + " for " + best.Recipe.title));
  }, { icon: "ti ti-shopping-cart-plus" }),
);`;

const recipesIndexScript = `// Recipe index
const recipeNotes = (await nb.search("#recipe"))
  .filter((note) => note.table("ingredients"))
  .sort((a, b) => a.title.localeCompare(b.title));

ui.render(
  ui.heading("Recipe index", 2),
  ui.table(recipeNotes.map((note) => {
    const meta = note.data("recipe")?.value ?? {};
    return {
      Recipe: note,
      Type: meta.type ?? "recipe",
      Time: meta.time ?? "",
      Ingredients: note.table("ingredients")?.rows.length ?? 0,
    };
  }), { emptyText: "No recipe notes yet." }),
);`;

const recipeReadinessScript = `// Pantry match for this recipe.
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
    Ingredient: row.Item,
    Need: row.Amount + " " + row.Unit,
    Pantry: missing ? "missing" : "yes",
    Notes: row.Notes,
    Action: missing ? ui.button("Add", async () => {
      await current.todo("shopping")?.add(row.Item + " for " + current.title);
      ui.toast("Added to shopping", { variant: "success" });
    }, { variant: "secondary", icon: "ti ti-shopping-cart-plus" }) : "",
  };
});
const missing = rows.filter((row) => row.Pantry !== "yes").map((row) => row.Ingredient);

ui.render(
  ui.heading("Pantry match", 3),
  ui.table(rows),
  ui.chart("donut", {
    data: [
      { label: "Have", value: rows.length - missing.length },
      { label: "Missing", value: missing.length },
    ],
    showLabels: true,
    height: 150,
  }),
  ui.button("Add missing here", async () => {
    if (missing.length === 0) return;
    await current.todo("shopping")?.add(...missing.map((item) => item + " for " + current.title));
    ui.toast("Missing ingredients added", { variant: "success" });
  }, { icon: "ti ti-shopping-cart-plus" }),
);`;

const recipeContent = (title: string, type: string, time: string, servings: number, rows: string, method: string) => `# ${title}

#recipe #bavarian

@recipe
:::data
type: ${type}
servings: ${servings}
time: ${time}
source: Bavarian home kitchen
:::

\`\`\`script
${recipeReadinessScript}
\`\`\`

@ingredients
| Item | Amount | Unit | Notes |
|---|---:|---|---|
${rows}

@shopping
- [ ] Add missing items here

## Method

${method}
`;

export const recipeCollectorTemplate: NotebookTemplate = {
  id: "recipe-collector",
  name: "Recipes & Pantry",
  description: "Recipes, pantry matching, shopping todos, and starter ideas.",
  icon: "ti ti-tools-kitchen-2",
  notebookName: "Recipes & Pantry",
  notebookDescription: "Recipe dashboard, pantry inventory, and recipe pages that calculate what ingredients you already have.",
  scriptsEnabled: true,
  homepageNoteKey: "dashboard",
  notes: () => [
    {
      key: "dashboard",
      content: (c) => `# Kitchen Dashboard

#kitchen

:::success
Start here. The dashboard compares recipe ingredient tables with your pantry and shows what you can cook soon.
:::

## How to use this kitchen notebook

1. Update ${c.link("pantry", "Pantry")} with what you have at home.
2. Open a recipe and keep its \`@ingredients\` table simple and consistent.
3. Use **Add best missing items** to create a small shopping list from the closest recipe.
4. Add new recipe pages only when you want notes, steps, or pantry matching for that dish.

:::info
Ingredient names are lookup keys. Use the same name in recipes and pantry, for example \`Mountain cheese\` in both places.
:::

\`\`\`script
${recipeDashboardScript}
\`\`\`

@shopping
- [ ] Buy fresh Brezn for Obazda
- [ ] Check cheese before cooking Kaesespaetzle
`,
    },
    {
      key: "pantry",
      content: `# Pantry

#pantry

@pantry
| Item | Amount | Unit | Reorder at | Typical use |
|---|---:|---|---:|---|
| Camembert | 250 | g | 150 | Obazda |
| Cream cheese | 200 | g | 100 | Obazda, dips |
| Onion | 1.2 | kg | 0.5 | sauces, salads, Obazda |
| Sweet paprika | 35 | g | 10 | Obazda |
| Brezn | 0 | pieces | 4 | Brotzeit |
| Eggs | 8 | pieces | 4 | Spaetzle |
| Flour | 1.5 | kg | 0.5 | Spaetzle, baking |
| Mountain cheese | 150 | g | 250 | Kaesespaetzle |
| Emmental | 250 | g | 200 | Kaesespaetzle |
| Franconian sausages | 0 | pairs | 4 | Blaue Zipfel |
| Franconian white wine | 1 | bottle | 1 | Blaue Zipfel |
| White wine vinegar | 700 | ml | 250 | Blaue Zipfel, salads |
| Bay leaves | 12 | leaves | 5 | broth and roasts |

:::info
The first column is the lookup key used by scripts. Exact names keep the app predictable.
:::
`,
    },
    {
      key: "recipes",
      content: `# Recipes

#recipes

\`\`\`script
${recipesIndexScript}
\`\`\`

## Recipe schema

- \`@recipe\` data stores metadata.
- \`@ingredients\` table drives pantry matching.
- \`@shopping\` todo receives missing ingredients.
`,
    },
    {
      key: "obazda",
      content: recipeContent(
        "Obazda with Radish and Brezn",
        "brotzeit",
        "15 min",
        4,
        `| Camembert | 250 | g | ripe, room temperature |
| Cream cheese | 80 | g | or soft butter |
| Onion | 0.2 | kg | finely diced, add late |
| Sweet paprika | 1 | tsp | plus pepper and salt |
| Brezn | 8 | pieces | buy fresh |
| Radish | 1 | piece | optional but classic |`,
        `1. Mash Camembert with cream cheese until creamy.
2. Season with paprika, pepper, salt, and a small splash of beer if wanted.
3. Fold in onions shortly before serving so they do not turn bitter.
4. Serve with Brezn, radish, chives, and a cold beer.`,
      ),
    },
    {
      key: "kaesespaetzle",
      content: recipeContent(
        "Kaesespaetzle with Fried Onions",
        "main",
        "50 min",
        4,
        `| Flour | 400 | g | wheat flour 405 or spaetzle flour |
| Eggs | 5 | pieces | medium |
| Mountain cheese | 250 | g | nutty cheese |
| Emmental | 150 | g | melting cheese |
| Onion | 0.5 | kg | slice thin |
| Butter | 60 | g | for onions and pan |`,
        `1. Beat flour, eggs, salt, and a little water until the dough bubbles.
2. Press into simmering salted water and lift when the spaetzle float.
3. Brown onions slowly in butter.
4. Layer hot spaetzle with grated cheese, cover briefly, then serve with onions.`,
      ),
    },
    {
      key: "blaue-zipfel",
      content: recipeContent(
        "Franconian Blaue Zipfel",
        "main",
        "45 min",
        4,
        `| Franconian sausages | 4 | pairs | raw, fresh |
| Onion | 0.7 | kg | sliced |
| Franconian white wine | 500 | ml | Silvaner works well |
| White wine vinegar | 500 | ml | mild vinegar |
| Bay leaves | 2 | leaves | with peppercorns and cloves |
| Carrot | 2 | pieces | quartered |`,
        `1. Simmer wine, vinegar, water, onions, carrots, bay, pepper, and cloves for 15 minutes.
2. Lower heat so the liquid no longer boils.
3. Add sausages and let them steep gently for 15-20 minutes.
4. Serve in deep plates with onions, broth, rye bread, and horseradish.`,
      ),
    },
  ],
};
