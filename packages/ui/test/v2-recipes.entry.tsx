import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import * as actions from "../skills/k2b-ui/recipes/actions";
import * as dialogs from "../skills/k2b-ui/recipes/dialogs";
import * as form from "../skills/k2b-ui/recipes/form";
import * as listDetail from "../skills/k2b-ui/recipes/list-detail";
import * as mail from "../skills/k2b-ui/recipes/mail";
import * as recordGroups from "../skills/k2b-ui/recipes/record-groups";
import * as record from "../skills/k2b-ui/recipes/record";
import * as states from "../skills/k2b-ui/recipes/states";
import * as table from "../skills/k2b-ui/recipes/table";

// The recipes of the k2b-ui skill in the browser, as Fibel's Example shows them: the page names a recipe and one of its
// states before this bundle runs; the bundle mounts it in #root. The test then presses what a `press` state names.

type State = (() => JSX.Element) | { render: () => JSX.Element; press: string | readonly string[] };
type Recipe = { default: (props: Record<string, never>) => JSX.Element; states?: Record<string, State> };

const recipes: Record<string, Recipe> = {
  "actions.tsx": actions,
  "dialogs.tsx": dialogs,
  "form.tsx": form,
  "list-detail.tsx": listDetail,
  "mail.tsx": mail,
  "record-groups.tsx": recordGroups,
  "record.tsx": record,
  "states.tsx": states,
  "table.tsx": table,
};

declare global {
  interface Window {
    __mounted: boolean;
    __recipe?: { name: string; state?: string };
    /** Every recipe with the names of its states and what each one presses. */
    __recipes: Record<string, Record<string, readonly string[]>>;
  }
}

const pressOf = (state: State): readonly string[] =>
  typeof state === "function" ? [] : typeof state.press === "string" ? [state.press] : state.press;
window.__recipes = Object.fromEntries(
  Object.entries(recipes).map(([name, recipe]) => [
    name,
    Object.fromEntries(Object.entries(recipe.states ?? {}).map(([key, state]) => [key, pressOf(state)])),
  ]),
);

const chosen = window.__recipe;
const root = document.getElementById("root");
if (chosen && root) {
  const recipe = recipes[chosen.name];
  if (!recipe) throw new Error(`v2-recipes: no recipe ${chosen.name}`);
  const state = chosen.state ? recipe.states?.[chosen.state] : undefined;
  if (chosen.state && !state) throw new Error(`v2-recipes: ${chosen.name} has no state ${chosen.state}`);
  const view = !state ? recipe.default : typeof state === "function" ? state : state.render;
  render(() => createComponent(view, {}), root);
}
window.__mounted = true;
