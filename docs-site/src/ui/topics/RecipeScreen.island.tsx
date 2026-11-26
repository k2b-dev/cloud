import { LocaleProvider } from "@k2b/ui";
import { onMount, Show } from "solid-js";
import { ScreenFrame } from "../../../../packages/ui/src/v2/screen-frame";
import { isRecipeName, recipeApp, recipeLocale, resolveRecipeState } from "./recipes";

/** How long a press waits for its button or menu item to appear, such as a menu that opens after a frame. */
const PRESS_TIMEOUT_MS = 3000;

const pressable =
  "button, a[href], [role='button'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='tab'], [role='option']";

/** The accessible name the way a person reads it: `aria-label`, then `aria-labelledby`, then the visible words. */
const accessibleName = (element: Element) => {
  const label = element.getAttribute("aria-label")?.trim();
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy)
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
};

const find = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(pressable)].find((element) => !element.closest("[inert]") && accessibleName(element) === name);

const waitFor = async (name: string) => {
  const deadline = performance.now() + PRESS_TIMEOUT_MS;
  for (;;) {
    const element = find(name);
    if (element) return element;
    if (performance.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/**
 * One recipe screen of the skill `k2b-ui`, full size and in the frame of a host, as Fibel's `Example` frames it. The server renders the screen
 * and the browser hydrates it, so it is live; a state with `press` then presses its buttons and menu items in order.
 * `data-recipe` on the root says `ready` when the screen stands as the state asks, or `missing: <name>` when a press
 * found nothing to press (the console says so too).
 */
export default function RecipeScreen(props: { name: string; state?: string }) {
  const resolved = () => (isRecipeName(props.name) ? resolveRecipeState(props.name, props.state) : undefined);
  let root: HTMLDivElement | undefined;
  onMount(async () => {
    const steps = resolved()?.press ?? [];
    for (const name of steps) {
      const element = await waitFor(name);
      if (!element) {
        root?.setAttribute("data-recipe", `missing: ${name}`);
        console.error(`Recipe ${props.name}, state ${props.state}: nothing to press named "${name}".`);
        return;
      }
      element.click();
    }
    root?.setAttribute("data-recipe", "ready");
  });
  return (
    <div class="k2-ui ui-v2-recipe" ref={root} data-recipe="hydrating">
      <Show when={resolved()} fallback={<p>No such recipe state.</p>}>
        {(state) => (
          <LocaleProvider locale={isRecipeName(props.name) ? recipeLocale(props.name) : "en"}>
            {/* the screen in the frame of a host (tinted page, rail of apps), as its pictures in the skill show it */}
            <ScreenFrame app={isRecipeName(props.name) ? recipeApp(props.name) : undefined}>{state().render()}</ScreenFrame>
          </LocaleProvider>
        )}
      </Show>
    </div>
  );
}
