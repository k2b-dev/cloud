import { type AiSecretRequestView, CODE_SECRET_ERRORS } from "@k2b/cloud/ai/ui";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { dates, i18n } from "@k2b/stdlib";
import { Chat, type ChatOutcomeLine, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import type { SecretRequestController, SecretRequestState } from "./secret-request";
import { getSecretRequest, observeSecretRequests } from "./secret-request-registry";
import type { SecretTitleStore } from "./secret-title-store";

const messages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      waiting: "Secret",
      saved: "Secret {name} saved",
      declined: "Secret {name} declined",
      expired: "Request for secret {name} no longer open. Nothing was saved.",
      signIn: "Secret {name} not saved: your sign-in expired. Nothing was saved.",
      editor: "Secret {name} not saved: you can no longer edit {title}, or it no longer exists. Nothing was saved.",
      chat: "Secret {name} not saved: you can no longer write in this chat, or it no longer exists. Nothing was saved.",
      theAutomation: "the automation",
      unknown: "Secret {name}: Cloud did not answer, so it may be saved.",
    },
    de: {
      waiting: "Secret",
      saved: "Secret {name} gespeichert",
      declined: "Secret {name} abgelehnt",
      expired: "Anfrage nach Secret {name} nicht mehr offen. Gespeichert ist nichts.",
      signIn: "Secret {name} nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts.",
      editor:
        "Secret {name} nicht gespeichert: Du darfst {title} nicht mehr bearbeiten, oder es gibt sie nicht mehr. Gespeichert ist nichts.",
      chat: "Secret {name} nicht gespeichert: Du kannst in diesem Chat nicht mehr schreiben, oder es gibt ihn nicht mehr. Gespeichert ist nichts.",
      theAutomation: "die Automation",
      unknown: "Secret {name}: Keine Antwort von Cloud, vielleicht gespeichert.",
    },
  },
});

type Outcome = "saved" | "declined" | "expired" | "access" | "signIn" | "unknown";
const OUTCOME_LINE: Record<Outcome, Pick<ChatOutcomeLine, "tone" | "icon">> = {
  saved: { tone: "done", icon: "ti ti-shield-check" },
  declined: { tone: "off", icon: "ti ti-key-off" },
  expired: { tone: "off", icon: "ti ti-clock-x" },
  access: { tone: "error", icon: "ti ti-lock" },
  signIn: { tone: "error", icon: "ti ti-lock" },
  unknown: { tone: "warning", icon: "ti ti-help-circle" },
};
const ENDED: Partial<Record<SecretRequestState["state"], Outcome>> = {
  saved: "saved",
  declined: "declined",
  expired: "expired",
  "access-lost": "access",
  "signed-out": "signIn",
  "outcome-unknown": "unknown",
};
/** Failures that end a call without a card ever showing: Gustav says why in his answer, the timeline shows no line. */
const NO_CARD: readonly string[] = [
  CODE_SECRET_ERRORS.editorRequired,
  CODE_SECRET_ERRORS.listFailed,
  CODE_SECRET_ERRORS.destinationRefused,
  CODE_SECRET_ERRORS.checkFailed,
];

/** The outcome a stored call names: only `{ configured, name }` or a fixed error survive the timeline. */
export const storedSecretOutcome = (state: string, result: unknown): Outcome | null => {
  if (state === "done") return "saved";
  if (state === "rejected") return "declined";
  if (state === "not_run") return "expired";
  if (state !== "failed") return null;
  const error = typeof result === "object" && result !== null && "error" in result ? result.error : null;
  if (typeof error === "string" && NO_CARD.includes(error)) return null;
  if (error === CODE_SECRET_ERRORS.accessLost) return "access";
  if (error === CODE_SECRET_ERRORS.signInExpired) return "signIn";
  if (error === CODE_SECRET_ERRORS.unknown) return "unknown";
  return "expired";
};

/** "Secret {name} saved" with the name in bold; the frame is the catalog's. */
const framed = (frame: string, name: string, title?: string): JSX.Element => {
  const parts = frame.split(/(\{name\}|\{title\})/);
  return parts.map((part) => (part === "{name}" ? <strong>{name}</strong> : part === "{title}" ? (title ?? "") : part));
};

const loadCard = () => importOnDemand(() => import("./SecretRequestCard"));
let cardModule: ReturnType<typeof loadCard> | undefined;
/** Loads the card once per window, as soon as an entry waits for this browser or finds its controller. */
export const preloadSecretCard = () => {
  cardModule ??= loadCard().then((loaded) => {
    // A failed load may be tried again by the next call; importOnDemand already offered a reload.
    if (!loaded) cardModule = undefined;
    return loaded;
  });
  return cardModule;
};

/**
 * A `code_secret` call in its place in the timeline. While it waits for this browser, the card from this window's
 * controller; afterwards one outcome line, from the controller while it lives and from the stored `{ configured, name }`
 * after a reload. The value never reaches this component: only the card's field holds it.
 */
export function SecretRequestEntry(
  props: AiSecretRequestView & {
    conversationId: () => string | null;
    timeZone: string;
    /** Automation titles from the page's request, so a reloaded line names its automation in the first frame. */
    titles?: SecretTitleStore;
  },
) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  // The timeline gives `code_secret` its public arguments only: name, origin, header, prefix and target.
  const arg = (key: string): unknown => {
    const value = props.block().args;
    return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const name = () => text(arg("name"));
  const target = () => {
    const value = arg("target");
    return typeof value === "object" && value !== null ? value : null;
  };
  const automation = () => target() !== null;
  const codeId = () => {
    const code = target() && Reflect.get(target()!, "code");
    return typeof code === "string" ? code : null;
  };
  // The controller of this window stays once found: its outcome shows until the stored result arrives.
  const [controller, setController] = createSignal<SecretRequestController>();
  const [state, setState] = createSignal<SecretRequestState>();
  const [card, setCard] = createSignal<Awaited<ReturnType<typeof loadCard>>>();
  let root: HTMLDivElement | undefined;
  // Whether the person answered here or was in the card when it closed; then the outcome line takes the focus.
  let answeredHere = false;
  let focusInside = false;
  const showCard = () =>
    void preloadSecretCard().then((loaded) => {
      if (loaded) setCard(() => loaded);
    });
  onMount(() => {
    let unsubscribe: (() => void) | undefined;
    const find = () => {
      const conversationId = props.conversationId();
      if (controller() || !conversationId) return;
      const found = getSecretRequest({ conversationId, turnId: props.turnId, callId: props.block().callId });
      if (!found) return;
      setController(found);
      unsubscribe = found.subscribe(setState);
      showCard();
    };
    onCleanup(observeSecretRequests(find));
    onCleanup(() => unsubscribe?.());
    find();
    if (props.state() === "interaction") showCard();
  });

  const ended = () => {
    const current = state();
    return current ? ENDED[current.state] : undefined;
  };
  const outcome = createMemo((): Outcome | null => ended() ?? storedSecretOutcome(props.state(), props.block().result));
  /** The card shows while this window's controller has an open request; the module is loaded by then. */
  const active = () => {
    const current = state();
    const owner = controller();
    if (!current || !owner || ended()) return undefined;
    return current.state === "unavailable" || current.state === "checking" ? undefined : { controller: owner, state: current };
  };
  // Until the card can show, the call is the step it was: a quiet busy line, also in the server's HTML.
  const waiting = () => (
    <Show when={props.state() === "interaction" && state()?.state !== "unavailable"}>
      <Chat.Activity label={`${t().waiting} ${name()}`} icon="ti ti-key" busy />
    </Show>
  );
  // An answer given here, or a request that ends while the person is in the card, moves the focus to the outcome line.
  createEffect(
    on(outcome, (next, previous) => {
      if (!next || previous || !(answeredHere || focusInside)) return;
      const active = document.activeElement;
      // The person moved on meanwhile: the focus stays where they are.
      if (active && active !== document.body && !root?.contains(active)) return;
      root?.querySelector<HTMLElement>(".k2b-chat-outcome")?.focus({ preventScroll: true });
    }),
  );
  // The mockup's "· 19:42" after the sentence; only this line adds the dot, other outcomes keep their own times.
  const time = () => {
    const at = props.block().at;
    return at ? `· ${dates.formatTime(at, { locale: locale(), timeZone: props.timeZone })}` : undefined;
  };
  /** This window's title while its controller lives, otherwise the one the page loaded; general words only when Core has none. */
  const title = () => {
    const live = state()?.title;
    if (live) return live;
    const code = codeId();
    return code ? (props.titles?.title(code) ?? null) : null;
  };
  // A chat opened without a reload asks once for the title of a line that names it.
  createEffect(() => {
    const code = codeId();
    if (outcome() === "access" && code && !state()?.title && props.titles?.title(code) === undefined) props.titles?.want(code);
  });
  const line = (key: Outcome): ChatOutcomeLine => {
    const words = t();
    const named = title();
    const automationName = named ? `„${named}“` : words.theAutomation;
    // The reason follows the cause the controller or the stored error names, never the mode alone.
    const frame = key === "access" ? (automation() ? words.editor : words.chat) : words[key];
    return { ...OUTCOME_LINE[key], text: framed(frame, name(), automationName), time: time() };
  };

  return (
    <div
      ref={root}
      class="contents"
      onFocusIn={() => {
        focusInside = true;
      }}
      onFocusOut={(event) => {
        // A card that closes takes its focused field along without a new target; that still counts as inside.
        if (event.relatedTarget instanceof Node) focusInside = Boolean(root?.contains(event.relatedTarget));
      }}
    >
      <Show
        when={outcome()}
        fallback={
          <Show when={card()} keyed fallback={waiting()}>
            {(loaded) => (
              <Show when={active()} fallback={waiting()}>
                {(current) => (
                  <loaded.SecretRequestCard
                    controller={current().controller}
                    state={current().state}
                    anchorId={props.block().id}
                    timeZone={props.timeZone}
                    onAnswer={() => {
                      answeredHere = true;
                    }}
                  />
                )}
              </Show>
            )}
          </Show>
        }
      >
        {(key) => <Chat.Outcome lines={{ [key()]: line(key()) }} current={key()} anchorId={props.block().id} />}
      </Show>
    </div>
  );
}
