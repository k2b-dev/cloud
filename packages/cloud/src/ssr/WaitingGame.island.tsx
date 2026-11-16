import { onCleanup, onMount } from "solid-js";
import { importOnDemand } from "../browser/reload";
import type { MaintenanceGameController, MaintenanceGameFactory, MaintenanceGameTexts } from "../maintenance-game";

export type WaitingGameProps = {
  t: MaintenanceGameTexts;
  /** Selector of the page content above the road; its bottom edge is the horizon. */
  anchor: string;
};

const GLOBAL = "__k2bLauf";

/** The game's source defines the factory as a global; nothing else may sit under its name. */
const isFactory = (value: unknown): value is MaintenanceGameFactory => typeof value === "function";

/**
 * Runs the platform's game source once per page. It is plain browser source, shared with the gateway's
 * self-contained maintenance page, so it arrives as text and runs as a script with the page's nonce, if any.
 */
const loadFactory = async (): Promise<MaintenanceGameFactory | undefined> => {
  const known: unknown = Reflect.get(window, GLOBAL);
  if (isFactory(known)) return known;
  const source = await importOnDemand(() => import("../maintenance-game/source"));
  if (!source) return undefined;
  const style = document.createElement("style");
  const script = document.createElement("script");
  const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
  if (nonce) {
    style.nonce = nonce;
    script.nonce = nonce;
  }
  style.textContent = source.LAUF_CSS;
  script.textContent = `window.${GLOBAL}=${source.LAUF_SCRIPT};`;
  document.head.append(style, script);
  const loaded: unknown = Reflect.get(window, GLOBAL);
  return isFactory(loaded) ? loaded : undefined;
};

/**
 * The waiting game of a generic error page: the robot waits on its road below the page's content, and Space, a tap on
 * the road or a click on an element marked `data-waiting-game-start` starts a round. The scene fills its positioned
 * parent behind the content; the page reserves the road's room, so nothing moves when the game code arrives.
 */
export default function WaitingGame(props: WaitingGameProps) {
  let host: HTMLDivElement | undefined;
  let game: MaintenanceGameController | undefined;
  const start = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("[data-waiting-game-start]")) game?.start();
  };
  onMount(() => {
    // Registered in the browser only: the server render has no document to clean up.
    document.addEventListener("click", start);
    onCleanup(() => document.removeEventListener("click", start));
    void loadFactory().then((factory) => {
      if (!factory || !host) return;
      game = factory({
        host,
        anchor: () => document.querySelector(props.anchor),
        t: props.t,
        dark: () => document.documentElement.classList.contains("dark"),
        // These pages never end a maintenance, so a round never waits for one.
        onFinish: () => {},
      });
      game.open();
    });
  });
  return <div ref={host} class="absolute inset-0 isolate" data-waiting-game />;
}
