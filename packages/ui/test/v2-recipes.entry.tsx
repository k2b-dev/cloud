import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import * as home from "../skills/k2b-ui/recipes/home";
import * as overview from "../skills/k2b-ui/recipes/overview";
import * as actions from "./v2-screens/actions";
import * as content from "./v2-screens/content";
import * as conversations from "./v2-screens/conversations";
import * as dialogs from "./v2-screens/dialogs";
import * as filteredTable from "./v2-screens/filtered-table";
import * as form from "./v2-screens/form";
import * as formDetail from "./v2-screens/form-detail";
import * as frame from "./v2-screens/frame";
import * as listDetail from "./v2-screens/list-detail";
import * as mail from "./v2-screens/mail";
import * as record from "./v2-screens/record";
import * as recordGroups from "./v2-screens/record-groups";
import * as settings from "./v2-screens/settings";
import * as states from "./v2-screens/states";
import * as table from "./v2-screens/table";
import * as tree from "./v2-screens/tree";

// The recipes of the k2b-ui skill and the test screens of v2-screens in the browser, as Fibel's Example shows them: the
// page names a screen and one of its states before this bundle runs; the bundle mounts it in #root. The test then
// presses what a `press` state names.

type State = (() => JSX.Element) | { render: () => JSX.Element; press: string | readonly string[] };
type Recipe = { default: (props: Record<string, never>) => JSX.Element; states?: Record<string, State> };

const recipes: Record<string, Recipe> = {
  "actions.tsx": actions,
  "content.tsx": content,
  "conversations.tsx": conversations,
  "dialogs.tsx": dialogs,
  "filtered-table.tsx": filteredTable,
  "form-detail.tsx": formDetail,
  "form.tsx": form,
  "frame.tsx": frame,
  "home.tsx": home,
  "list-detail.tsx": listDetail,
  "mail.tsx": mail,
  "overview.tsx": overview,
  "record-groups.tsx": recordGroups,
  "settings.tsx": settings,
  "record.tsx": record,
  "states.tsx": states,
  "table.tsx": table,
  "tree.tsx": tree,
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
