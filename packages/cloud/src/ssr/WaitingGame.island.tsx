import { ButtonLink } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { importOnDemand } from "../browser/reload";
import type { MaintenanceGameController, MaintenanceGameFactory, MaintenanceGameTexts } from "../maintenance-game";

export type WaitingGameProps = {
  t: MaintenanceGameTexts;
  title: string;
  description: string;
  action: { label: string; href: string };
  /** Tabler class of the page's symbol, which starts a round. */
  icon: string;
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
 * „Play for a moment?“ below a generic error page. The game opens over the whole window with the page's heading and
 * way out on top, never starts on its own, and Escape or „Leave game“ return here.
 */
export default function WaitingGame(props: WaitingGameProps) {
  // The layer stays in the document once opened: the game keeps its canvas and record between rounds.
  const [mounted, setMounted] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let entry: HTMLButtonElement | undefined;
  let host: HTMLDivElement | undefined;
  let head: HTMLDivElement | undefined;
  let game: MaintenanceGameController | undefined;

  const launch = async (round: boolean) => {
    setMounted(true);
    setOpen(true);
    if (!game) {
      const factory = await loadFactory();
      if (!factory || !host) {
        setOpen(false);
        entry?.focus();
        return;
      }
      game = factory({
        host,
        anchor: () => head ?? null,
        t: props.t,
        dark: () => document.documentElement.classList.contains("dark"),
        onClose: () => {
          setOpen(false);
          entry?.focus();
        },
        // These pages never end a maintenance, so a round never waits for one.
        onFinish: () => {},
      });
    }
    if (round) game.start();
    else game.open();
  };
  onCleanup(() => game?.close());

  return (
    <>
      <button
        ref={entry}
        type="button"
        class="cursor-pointer text-sm text-[var(--k2b-text-muted)] underline decoration-[var(--k2b-border)] underline-offset-[3px] hover:text-[var(--k2b-text-secondary)] hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--k2b-focus-ring)]"
        data-waiting-game
        onClick={() => void launch(false)}
      >
        {props.t.play}
      </button>
      <Show when={mounted()}>
        <Portal>
          <div
            ref={host}
            hidden={!open()}
            class="fixed inset-0 z-[60] bg-[var(--k2b-surface)] text-[var(--k2b-text)]"
            data-waiting-game-layer
          >
            <div ref={head} class="relative z-[2] mx-auto w-full max-w-[31rem] px-4 pt-[6vh] [[data-lauf=run]_&]:pt-2.5">
              <div class="grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none [[data-lauf=run]_&]:grid-rows-[0fr] [[data-lauf=run]_&]:opacity-0">
                <div class="min-h-0 overflow-hidden">
                  <button
                    type="button"
                    class="mb-4 grid size-11 cursor-pointer place-items-center rounded-xl bg-[var(--k2b-surface-muted)] text-[var(--k2b-text-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--k2b-focus-ring)]"
                    aria-label={props.t.start}
                    onClick={() => void launch(true)}
                  >
                    <i class={`${props.icon} text-2xl`} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <h1 class="m-0 text-[26px] leading-tight font-semibold tracking-[-0.02em] max-sm:text-[23px] [[data-lauf=run]_&]:text-lg">
                {props.title}
              </h1>
              <div class="grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none [[data-lauf=run]_&]:grid-rows-[0fr] [[data-lauf=run]_&]:opacity-0">
                <div class="min-h-0 overflow-hidden">
                  <p class="m-0 mt-2 text-base text-[var(--k2b-text-secondary)]">{props.description}</p>
                </div>
              </div>
              <div class="mt-5 flex min-h-11 items-center [[data-lauf=run]_&]:mt-2">
                <ButtonLink href={props.action.href} variant="primary" size="sm">
                  {props.action.label}
                </ButtonLink>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
