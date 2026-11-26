import { ErrorScreen } from "@k2b/ui/v2";
import { onCleanup, onMount } from "solid-js";
import type { MaintenanceGameController, MaintenanceGameTexts } from "../maintenance-game";
import { loadMaintenanceGame } from "./maintenance-game-loader";

/** Space belongs to the page only when nothing that takes keys has the focus: no field, button, link or editor. */
const pageHasTheKeys = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (target.closest("input, textarea, select, button, a[href], [contenteditable=''], [contenteditable='true'], [role='textbox'], dialog"))
    return false;
  return target.closest('[data-k2-part="ErrorScreen"]') !== null;
};

/**
 * The waiting game's invitation at the foot of an error page: a symbol and quiet words, nothing drawn until the person
 * asks. The button starts it, and so does Space while the focus is on the page itself (as a browser's offline game
 * does), never while typing in a field such as the shell's search. The game then plays on the error screen's stage:
 * the words move to the top and stay reachable, the road runs below the ways out, and a round starts. There is one
 * game per page; it handles motion and keys itself from then on.
 */
export default function ErrorPageGame(props: { t: MaintenanceGameTexts; keys: string; touch: string }) {
  let game: MaintenanceGameController | undefined;
  let loading = false;
  const start = async () => {
    if (game) return game.start();
    if (loading) return;
    loading = true;
    const host = document.querySelector<HTMLElement>('[data-k2-part="ErrorScreen"]');
    const factory = host ? await loadMaintenanceGame() : undefined;
    loading = false;
    if (!factory || !host || game) return;
    game = factory({
      host,
      anchor: () => host.querySelector(".k2-es-stack"),
      t: props.t,
      dark: () => document.documentElement.classList.contains("dark"),
      // These pages never end a maintenance, so a round never waits for one.
      onFinish: () => {},
    });
    host.setAttribute("data-k2-stage", "");
    game.open();
    game.start();
  };
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      // once the game is open, it takes Space itself
      if (game || loading || event.key !== " " || event.isComposing || event.repeat || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || !pageHasTheKeys(event.target)) return;
      event.preventDefault();
      void start();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  return <ErrorScreen.Invite icon="robot" label={props.t.start} keys={props.keys} touch={props.touch} onClick={() => void start()} />;
}
