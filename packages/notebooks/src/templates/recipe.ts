import { recipeNotesDe } from "./recipe.de";
import type { NotebookTemplate } from "./types";

const recipeContent = (title: string, type: string, time: string, servings: number, rows: string, method: string) => `# ${title}

#recipe #bavarian

@recipe
:::data
type: ${type}
servings: ${servings}
time: ${time}
source: Bavarian home kitchen
:::

:::toc
min-depth: 2
:::

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
  description: "Recipes, pantry inventory, shopping todos, and starter ideas.",
  icon: "ti ti-tools-kitchen-2",
  notebookName: "Recipes & Pantry",
  notebookDescription: "An automatic recipe index, pantry inventory, and readable recipe pages.",
  translations: {
    de: {
      name: "Rezepte und Vorräte",
      description: "Rezepte, Vorratsbestand, Einkaufsliste und Anregungen für den Einstieg.",
      notebookName: "Rezepte und Vorräte",
      notebookDescription: "Automatisches Rezeptverzeichnis, Vorratsbestand und lesbare Rezeptseiten.",
    },
  },
  homepageNoteKey: "dashboard",
  notes: (ctx) =>
    ctx.locale?.toLowerCase().split("-")[0] === "de"
      ? recipeNotesDe()
      : [
          {
            key: "dashboard",
            content: (c) => `# Kitchen Dashboard

#kitchen

:::success
Start here. Browse recipes in the automatic index and compare their ingredients with your pantry before shopping.
:::

## How to use this kitchen notebook

1. Update ${c.link("pantry", "Pantry")} with what you have at home.
2. Open a recipe and keep its \`@ingredients\` table simple and consistent.
3. Add missing ingredients to the shopping list below.
4. Add new recipe pages only when you want notes or preparation steps for that dish.

:::info
Consistent ingredient names help you compare recipes and pantry. Use the same name in recipes and pantry, for example \`Mountain cheese\` in both places.
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
Update amounts after shopping and cooking. Compare this table with the recipe ingredients when planning a meal.
:::
`,
          },
          {
            key: "recipes",
            content: `# Recipes

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

## Recipe schema

- \`@recipe\` data stores metadata.
- \`@ingredients\` table records ingredient quantities.
- \`@shopping\` todo is your checklist for missing ingredients.
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
