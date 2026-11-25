import { createComponent, type JSX } from "solid-js";
import * as form from "../../../../packages/ui/skills/k2b-ui/recipes/form";
import * as formDetail from "../../../../packages/ui/skills/k2b-ui/recipes/form-detail";
import * as frame from "../../../../packages/ui/skills/k2b-ui/recipes/frame";
import * as listDetail from "../../../../packages/ui/skills/k2b-ui/recipes/list-detail";
import * as mail from "../../../../packages/ui/skills/k2b-ui/recipes/mail";
import * as record from "../../../../packages/ui/skills/k2b-ui/recipes/record";
import * as recordGroups from "../../../../packages/ui/skills/k2b-ui/recipes/record-groups";
import * as table from "../../../../packages/ui/skills/k2b-ui/recipes/table";

/**
 * One state a recipe offers beside its default screen, such as `empty`, `loading` or `failed`.
 *
 * - A function renders the state on the server and in the browser, like the default screen.
 * - `{ render, press }` renders the screen and, after it hydrated in the browser, presses what `press` names, in
 *   order: the accessible name of a button, then the names of menu items. Overlays (`Menu`, `Popover`, `Dialog`,
 *   toasts) render nothing on the server and open only through their real behaviour, so such a state opens them the
 *   way a person would.
 */
export type RecipeState = (() => JSX.Element) | { render: () => JSX.Element; press: string | readonly string[] };

/**
 * A recipe of the skill `k2b-ui`: a file under `packages/ui/skills/k2b-ui/recipes/` whose default export is the whole
 * screen, rendered without props, and whose optional `states` export holds its other states by name. The default may
 * take optional props that its states pass (`<OpenInvoices loading />`).
 */
export type RecipeModule = {
  default: (props: Record<never, never>) => JSX.Element;
  states?: Readonly<Record<string, RecipeState>>;
  /** The language of the recipe's sample text, so the library's own words ("Erneut versuchen") match it. */
  locale?: string;
};

/** Recipes write their sample text in German (see the skill), so German is the default for the library's words. */
const RECIPE_LOCALE = "de";

/** Every recipe by its file name without `.tsx`. A new recipe file is one line here; a test fails on a missing one. */
export const recipes = {
  form,
  "form-detail": formDetail,
  frame,
  "list-detail": listDetail,
  mail,
  record,
  "record-groups": recordGroups,
  table,
} satisfies Record<string, RecipeModule>;

export type RecipeName = keyof typeof recipes;

export const isRecipeName = (name: string): name is RecipeName => Object.hasOwn(recipes, name);

/** Every recipe name, in file order. */
export const recipeNames: readonly RecipeName[] = Object.keys(recipes).filter(isRecipeName);

/** The states of a recipe beside its default, in the order the file declares them. */
export const recipeStates = (name: RecipeName): Readonly<Record<string, RecipeState>> => {
  const recipe: RecipeModule = recipes[name];
  return recipe.states ?? {};
};

/** The language a recipe renders in: its own `locale`, else German. */
export const recipeLocale = (name: RecipeName) => {
  const recipe: RecipeModule = recipes[name];
  return recipe.locale ?? RECIPE_LOCALE;
};

/** What a state renders and, for a state that opens an overlay, what is pressed after hydration. */
export const resolveRecipeState = (name: RecipeName, state: string | undefined) => {
  const recipe: RecipeModule = recipes[name];
  if (!state) return { render: () => createComponent(recipe.default, {}), press: [] as readonly string[] };
  const found = recipeStates(name)[state];
  if (!found) return undefined;
  if (typeof found === "function") return { render: found, press: [] as readonly string[] };
  return { render: found.render, press: typeof found.press === "string" ? [found.press] : found.press };
};
