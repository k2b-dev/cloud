import { createEffect, createSignal, Index, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { Button, IconButton } from "../../actions/Button";
import { Dropdown } from "../../actions/Dropdown";
import { useLocale } from "../../intl/locale";
import { AnchoredPopover } from "../../layout/AnchoredPopover";
import { type DictationController, type DictationNotice, isBarNotice } from "./create-dictation";
import { dictationMessages } from "./dictation-messages";
import type { DictationDevice } from "./types";

const useDictationMessages = () => {
  const locale = useLocale();
  return () => dictationMessages.resolve([locale()]).t;
};

/** Whether the bar stands in for the host's controls: while dictating, finishing, or showing a bar notice. */
export const dictationBarShown = (dictation: DictationController) => dictation.active() || isBarNotice(dictation.notice());

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The quiet countdown starts one minute before the end. */
const warnMs = 60_000;

const deviceIcon = (device: DictationDevice | undefined) => {
  const label = device?.label ?? "";
  if (/airpods|buds|headset|headphone|kopfhörer/i.test(label)) return "ti-headphones";
  if (/iphone|android|phone|handy|mobile/i.test(label)) return "ti-device-mobile";
  if (/macbook|laptop|built-in|internal|intern/i.test(label) || !label) return "ti-device-laptop";
  return "ti-microphone";
};

export type DictationButtonProps = {
  dictation: DictationController;
  size?: "xs" | "sm";
  class?: string;
  /** The box the notice cards line up with, such as the whole composer; defaults to the button. */
  cardAnchor?: () => HTMLElement | undefined;
};

/**
 * The microphone at its fixed place. A press starts live dictation; offline it stays focusable and says why it waits.
 * Notices that need a decision, such as a blocked microphone or a used-up allowance, open as cards above it.
 */
export function DictationButton(props: DictationButtonProps): JSX.Element {
  const t = useDictationMessages();
  const [button, setButton] = createSignal<HTMLButtonElement>();
  const card = () => {
    const notice = props.dictation.notice();
    return notice && !isBarNotice(notice) ? notice : null;
  };
  createEffect(() => props.dictation.bind("microphone", button()));
  onCleanup(() => props.dictation.bind("microphone", undefined));
  return (
    <>
      <IconButton
        ref={setButton}
        size={props.size ?? "sm"}
        class={`k2b-dictation-button ${props.class ?? ""}`}
        label={props.dictation.offline() ? t().dictateOffline : t().dictate}
        tooltip={props.dictation.offline() ? t().offline : t().dictate}
        aria-pressed={props.dictation.active() ? "true" : "false"}
        aria-disabled={props.dictation.offline() ? "true" : undefined}
        data-notice={card()?.kind}
        onClick={() => {
          if (props.dictation.offline()) return;
          if (props.dictation.active()) void props.dictation.stop();
          else props.dictation.start();
        }}
      >
        <i class={`ti ${card()?.kind === "blocked" ? "ti-microphone-off" : "ti-microphone"}`} aria-hidden="true" />
      </IconButton>
      <Show when={card()}>
        {(notice) => (
          <DictationCard dictation={props.dictation} notice={notice()} anchor={props.cardAnchor?.() ?? button()} />
        )}
      </Show>
    </>
  );
}

function DictationCard(props: { dictation: DictationController; notice: DictationNotice; anchor: HTMLElement | undefined }) {
  const t = useDictationMessages();
  const locale = useLocale();
  const resetTime = () => {
    const notice = props.notice;
    const at = notice.kind === "quota" && notice.resetsAt ? new Date(notice.resetsAt) : null;
    const time = (at ?? new Date(new Date().setHours(24, 0, 0, 0))).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    const tomorrow = !at || at.toDateString() !== today.toDateString();
    return tomorrow ? t().quotaBodyTomorrow({ time }) : t().quotaBody({ time });
  };
  const content = (): { icon: string; title: string; body: JSX.Element; retry: boolean } => {
    switch (props.notice.kind) {
      case "blocked":
        return {
          icon: "ti-microphone-off",
          title: t().blockedTitle,
          body: (
            <>
              <p>{t().blockedBody}</p>
              <ol>
                <li>{t().blockedStep1}</li>
                <li>{t().blockedStep2}</li>
              </ol>
            </>
          ),
          retry: true,
        };
      case "quota":
        return { icon: "ti-hourglass", title: t().quotaTitle, body: <p>{resetTime()}</p>, retry: false };
      case "overloaded":
        return {
          icon: "ti-hourglass",
          title: t().overloadedTitle,
          body: <p>{props.dictation.alternative?.note ?? t().overloadedBody}</p>,
          retry: true,
        };
      case "elsewhere":
        return { icon: "ti-microphone", title: t().elsewhereTitle, body: <p>{t().elsewhereBody}</p>, retry: false };
      case "unavailable":
        return { icon: "ti-microphone-off", title: t().unavailableTitle, body: <p>{t().unavailableBody}</p>, retry: true };
      default:
        return { icon: "ti-microphone-off", title: t().notAvailableTitle, body: <p>{t().notAvailableBody}</p>, retry: false };
    }
  };
  return (
    <AnchoredPopover
      anchor={props.anchor}
      onClose={() => props.dictation.dismiss()}
      label={content().title}
      side="above"
      align="end"
      width="min(20rem, calc(100vw - 2.5rem))"
      sheet={false}
      class="k2b-dictation-card"
    >
      <h3 class="k2b-dictation-card__title">
        <i class={`ti ${content().icon}`} aria-hidden="true" />
        {content().title}
      </h3>
      <div class="k2b-dictation-card__body">{content().body}</div>
      <div class="k2b-dictation-card__actions">
        <Show when={props.notice.kind === "overloaded" ? props.dictation.alternative : undefined}>
          {(alternative) => (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                props.dictation.dismiss();
                alternative().run();
              }}
            >
              {alternative().label}
            </Button>
          )}
        </Show>
        <Show
          when={content().retry}
          fallback={
            <Button size="sm" variant="ghost" class={props.notice.kind === "elsewhere" ? "k2b-dictation-card__primary" : undefined} onClick={() => props.dictation.dismiss()}>
              {t().ok}
            </Button>
          }
        >
          <Button size="sm" variant="ghost" class="k2b-dictation-card__primary" onClick={() => props.dictation.start()}>
            {t().retry}
          </Button>
        </Show>
      </div>
    </AnchoredPopover>
  );
}

export type DictationBarProps = {
  dictation: DictationController;
  class?: string;
};

/**
 * The row that stands in for the host's controls while dictating, at the same place and height: Discard, level, time,
 * microphone and Stop; then "Finishing …" until the last words arrived; and a notice with "Continue" when the session
 * ended early. Render it where `dictationBarShown()` is true. Escape stops, after closing an open menu.
 */
export function DictationBar(props: DictationBarProps): JSX.Element {
  const t = useDictationMessages();
  const status = () => props.dictation.status();
  const remaining = () => props.dictation.maxMs() - props.dictation.elapsedMs();
  const warning = () => status() === "live" && remaining() <= warnMs;
  const time = () => (warning() ? t().timeLeft({ time: clock(remaining()) }) : clock(props.dictation.elapsedMs()));
  const slots = 160;
  const bars = () => {
    const levels = props.dictation.levels();
    return Array.from({ length: slots }, (_, index) => levels[levels.length - slots + index] ?? 0);
  };
  const deviceLabel = () => props.dictation.device()?.label || t().microphone;

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || status() !== "live") return;
    event.preventDefault();
    void props.dictation.stop();
  };
  createEffect(() => {
    if (status() !== "live") return;
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  const bindStop = (element: HTMLElement) => {
    props.dictation.bind("stop", element);
    onCleanup(() => props.dictation.bind("stop", undefined));
  };
  const bindContinue = (element: HTMLElement) => {
    props.dictation.bind("continue", element);
    onCleanup(() => props.dictation.bind("continue", undefined));
  };

  const deviceItems = () => [
    {
      sectionLabel: t().microphone,
      items: (props.dictation.devices().length ? props.dictation.devices() : props.dictation.device() ? [props.dictation.device()!] : []).map(
        (device) => ({
          choice: "radio" as const,
          icon: `ti ${deviceIcon(device)}`,
          label: device.id === "default" ? `${device.label || t().microphone} · ${t().systemDefault}` : device.label || t().microphone,
          checked: () => (props.dictation.deviceId() ?? props.dictation.device()?.id) === device.id,
          action: () => props.dictation.chooseDevice(device.id),
        }),
      ),
    },
  ];

  return (
    <div class={`k2b-dictation-bar ${props.class ?? ""}`}>
      <Switch>
        <Match when={status() === "finishing"}>
          <div class="k2b-dictation-bar__row" data-state="finishing" role="group" aria-label={t().finishingGroup}>
            <IconButton size="sm" label={t().discard} aria-disabled="true" class="k2b-dictation-bar__icon">
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
            <div class="k2b-dictation-bar__status" role="status">
              <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
              <span class="k2b-dictation-bar__message">{t().finishing}</span>
            </div>
            <span class="k2b-dictation-bar__time">{clock(props.dictation.elapsedMs())}</span>
            <span class="k2b-dictation-bar__stop" data-disabled="true" aria-hidden="true">
              <span />
            </span>
          </div>
        </Match>
        <Match when={status() === "live" || status() === "starting"}>
          <div class="k2b-dictation-bar__row" data-state={status()} role="group" aria-label={t().running}>
            <IconButton size="sm" label={t().discard} class="k2b-dictation-bar__icon" onClick={() => props.dictation.discard()}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
            <span class="k2b-dictation-bar__dot" data-live={status() === "live" ? "true" : undefined} aria-hidden="true" />
            <div class="k2b-dictation-bar__wave" aria-hidden="true">
              <Index each={bars()}>{(level) => <span style={{ "--k2b-dictation-level": String(0.1 + level() * 0.9) }} />}</Index>
            </div>
            <span class="k2b-dictation-bar__time" data-warning={warning() ? "true" : undefined}>
              {status() === "starting" ? clock(0) : time()}
            </span>
            <Dropdown
              items={deviceItems()}
              position="top-left"
              width="16.25rem"
              onOpenChange={(open) => {
                if (open) void props.dictation.loadDevices();
              }}
            >
              <Dropdown.Trigger
                appearance="plain"
                class="k2b-dictation-bar__device"
                label={t().microphoneNamed({ name: deviceLabel() })}
              >
                <i class={`ti ${deviceIcon(props.dictation.device())}`} aria-hidden="true" />
                <span class="k2b-dictation-bar__device-name">{deviceLabel()}</span>
                <i class="ti ti-chevron-down k2b-dictation-bar__device-chevron" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown>
            <button
              ref={bindStop}
              type="button"
              class="k2b-dictation-bar__stop"
              aria-label={t().stop}
              title={t().stop}
              onClick={() => void props.dictation.stop()}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </Match>
        <Match when={isBarNotice(props.dictation.notice()) ? props.dictation.notice() : undefined}>
          {(notice) => {
            const ended = () => {
              const value = notice();
              return value.kind === "ended" ? value : undefined;
            };
            const minutes = () => Math.round((ended()?.maxMs ?? 600_000) / 60_000);
            const long = () =>
              !ended() ? t().interrupted : ended()!.reason === "silence" ? t().silenceDone : t().maxDone({ minutes: minutes() });
            const short = () =>
              !ended() ? t().interruptedShort : ended()!.reason === "silence" ? t().silenceDoneShort : t().maxDoneShort({ minutes: minutes() });
            return (
              <div class="k2b-dictation-bar__row" data-state="notice">
                <div class="k2b-dictation-bar__status" data-tone={ended() ? undefined : "danger"} role="status">
                  <i class={`ti ${ended() ? "ti-clock" : "ti-alert-circle"}`} aria-hidden="true" />
                  <span class="k2b-dictation-bar__message k2b-dictation-bar__message--long">{long()}</span>
                  <span class="k2b-dictation-bar__message k2b-dictation-bar__message--short" aria-hidden="true">
                    {short()}
                  </span>
                </div>
                <Button ref={bindContinue} size="sm" variant="ghost" class="k2b-dictation-bar__continue" onClick={() => props.dictation.start()}>
                  {t().continue}
                </Button>
                <IconButton size="sm" label={t().dismiss} class="k2b-dictation-bar__icon" onClick={() => props.dictation.dismiss()}>
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </div>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}
