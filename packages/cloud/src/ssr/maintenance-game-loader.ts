import { importOnDemand } from "../browser/reload";
import type { MaintenanceGameFactory } from "../maintenance-game";

const GLOBAL = "__k2bLauf";

/** The game's source defines the factory as a global; nothing else may sit under its name. */
const isFactory = (value: unknown): value is MaintenanceGameFactory => typeof value === "function";

/**
 * Runs the platform's game source once per page and returns its factory. It is plain browser source, shared with the
 * gateway's self-contained maintenance page, so it arrives as text and runs as a script with the page's nonce, if any.
 */
export const loadMaintenanceGame = async (): Promise<MaintenanceGameFactory | undefined> => {
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
