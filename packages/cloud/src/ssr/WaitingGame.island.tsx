import { onMount } from "solid-js";
import { importOnDemand } from "../browser/reload";
import type { MaintenanceGameFactory, MaintenanceGameTexts } from "../maintenance-game";

export type WaitingGameProps = { t: MaintenanceGameTexts };

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
 * The waiting game below a generic error page: the robot waits on its road, and Space or a tap starts a round. The
 * server renders the scene's box at its final size, so the page does not move when the game code arrives.
 */
export default function WaitingGame(props: WaitingGameProps) {
  let host: HTMLDivElement | undefined;
  onMount(() => {
    void loadFactory().then((factory) => {
      if (!factory || !host) return;
      factory({
        host,
        anchor: () => null,
        t: props.t,
        dark: () => document.documentElement.classList.contains("dark"),
        // These pages never end a maintenance, so a round never waits for one.
        onFinish: () => {},
      }).open();
    });
  });
  return <div ref={host} class="relative isolate h-[clamp(20rem,52vh,32rem)] w-full shrink-0" data-waiting-game />;
}
