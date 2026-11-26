import { Chip } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { importOnDemand } from "../browser/reload";
import type { MaintenanceGameFactory, MaintenanceGameTexts } from "../maintenance-game";

const GLOBAL = "__k2bLauf";

/** The game's source defines the factory as a global; nothing else may sit under its name. */
const isFactory = (value: unknown): value is MaintenanceGameFactory => typeof value === "function";

/** Runs the platform's game source once per page, with the page's nonce, as the gateway's maintenance page does. */
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
 * The waiting game's invitation at the foot of an error page: nothing is drawn until the person asks. Then the game
 * opens over the error screen, its road below the page's words, and a round starts.
 */
export default function ErrorPageGame(props: { t: MaintenanceGameTexts }) {
  const [busy, setBusy] = createSignal(false);
  const start = async () => {
    if (busy()) return;
    setBusy(true);
    const host = document.querySelector<HTMLElement>('[data-k2-part="ErrorScreen"]');
    const factory = host ? await loadFactory() : undefined;
    setBusy(false);
    if (!factory || !host) return;
    const game = factory({
      host,
      anchor: () => host.querySelector(".k2-es-stack"),
      t: props.t,
      dark: () => document.documentElement.classList.contains("dark"),
      // These pages never end a maintenance, so a round never waits for one.
      onFinish: () => {},
    });
    game.open();
    game.start();
  };
  return (
    <Chip icon="robot" onClick={() => void start()}>
      {props.t.start}
    </Chip>
  );
}
