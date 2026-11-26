import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import * as actions from "../skills/k2b-ui/recipes/actions";
import * as content from "../skills/k2b-ui/recipes/content";
import * as dialogs from "../skills/k2b-ui/recipes/dialogs";
import * as filteredTable from "../skills/k2b-ui/recipes/filtered-table";
import * as form from "../skills/k2b-ui/recipes/form";
import * as formDetail from "../skills/k2b-ui/recipes/form-detail";
import * as frame from "../skills/k2b-ui/recipes/frame";
import * as home from "../skills/k2b-ui/recipes/home";
import * as listDetail from "../skills/k2b-ui/recipes/list-detail";
import * as mail from "../skills/k2b-ui/recipes/mail";
import * as overview from "../skills/k2b-ui/recipes/overview";
import * as record from "../skills/k2b-ui/recipes/record";
import * as recordGroups from "../skills/k2b-ui/recipes/record-groups";
import * as states from "../skills/k2b-ui/recipes/states";
import * as table from "../skills/k2b-ui/recipes/table";
import { type ScreenApp, ScreenFrame } from "../src/v2/screen-frame";

// The recipes of the k2b-ui skill in the browser, as Fibel's Example shows them: the page names a recipe and one of its
// states before this bundle runs; the bundle mounts it in #root. The test then presses what a `press` state names.

type State = (() => JSX.Element) | { render: () => JSX.Element; press: string | readonly string[] };
type Recipe = { default: (props: Record<string, never>) => JSX.Element; states?: Record<string, State>; app?: ScreenApp };

const recipes: Record<string, Recipe> = {
  "actions.tsx": actions,
  "content.tsx": content,
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
  // in the frame of a host, as Fibel and the skill's pictures show every recipe
  render(
    () =>
      createComponent(ScreenFrame, {
        app: recipe.app,
        get children() {
          return createComponent(view, {});
        },
      }),
    root,
  );
}
window.__mounted = true;
