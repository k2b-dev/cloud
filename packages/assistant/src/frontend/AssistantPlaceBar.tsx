import { AnchoredPopover, Button, IconButton, Skeleton, Tag, Tooltip, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { type AssistantPlaceView, placePolicyText } from "./assistant-place";
import { placeMessages } from "./place-messages";

type Available = Extract<AssistantPlaceView, { state: "available" }>;
type Unavailable = Extract<AssistantPlaceView, { state: "unavailable" }>;

/**
 * What the bar shows. `place`: the open chat belongs to this place (or the panel waits for its first message there).
 * `gone`: the chat's place is unavailable. `switch`: another chat stays open and the page's place is one click away.
 */
export type AssistantPlaceBarState =
  | { kind: "place"; view: Available }
  | { kind: "gone"; view: Unavailable }
  | { kind: "switch"; view: Available | Unavailable; onSwitch: () => void; busy?: boolean; disabled?: boolean }
  | { kind: "loading" }
  | { kind: "failed"; onRetry: () => void };

const placeTitle = (view: Available | Unavailable): string | null => view.title;

/**
 * The place bar at the top of the side panel: which place the chat belongs to, that only the person reads it, and
 * what Gustav can do here in addition. Its first row keeps one height in every state, so switching places, loading and
 * losing access never move the chat below.
 */
export default function AssistantPlaceBar(props: { state: AssistantPlaceBarState }) {
  const locale = useLocale();
  const t = () => placeMessages.resolve([locale()]).t;
  const [infoAnchor, setInfoAnchor] = createSignal<HTMLElement | null>(null);
  let infoButton: HTMLButtonElement | undefined;

  const PlaceChip = (chip: { view: Available | Unavailable; struck?: boolean }) => (
    <Tag size="sm" icon={chip.view.app?.icon ?? "ti ti-map-pin"} class="assistant-place-chip">
      <span classList={{ "line-through": Boolean(chip.struck) }}>{placeTitle(chip.view) ?? t().goneUnnamed}</span>
    </Tag>
  );
  const OnlyYou = () => (
    <Tooltip.Anchor content={t().onlyYouHint} class="assistant-place-only-you">
      <i class="ti ti-lock" aria-hidden="true" />
      <span>{t().onlyYou}</span>
      <span class="sr-only">{t().onlyYouHint}</span>
    </Tooltip.Anchor>
  );
  const Info = (info: { view: Available }) => (
    <>
      <IconButton
        ref={infoButton}
        size="xs"
        label={t().whatHere}
        aria-expanded={infoAnchor() ? "true" : "false"}
        onClick={() => setInfoAnchor((open) => (open ? null : (infoButton ?? null)))}
      >
        <i class="ti ti-info-circle" aria-hidden="true" />
      </IconButton>
      <AnchoredPopover anchor={infoAnchor()} onClose={() => setInfoAnchor(null)} label={t().whatHereTitle} width="22rem">
        <WhatHere view={info.view} onClose={() => setInfoAnchor(null)} />
      </AnchoredPopover>
    </>
  );

  return (
    <div
      class="assistant-place-bar"
      role="group"
      aria-label={t().barLabel}
      aria-busy={props.state.kind === "loading" ? "true" : undefined}
      data-kind={props.state.kind}
    >
      <Switch>
        <Match when={props.state.kind === "place" && props.state}>
          {(state) => (
            <>
              <div class="assistant-place-bar__row">
                <PlaceChip view={state().view} />
                <span class="assistant-place-bar__app">{state().view.app.name}</span>
                <span class="grow" />
                <OnlyYou />
                <Info view={state().view} />
              </div>
              <PlaceChips view={state().view} />
            </>
          )}
        </Match>
        <Match when={props.state.kind === "gone" && props.state}>
          {(state) => (
            <>
              <div class="assistant-place-bar__row">
                <PlaceChip view={state().view} struck />
                <Show when={state().view.app}>{(app) => <span class="assistant-place-bar__app">{app().name}</span>}</Show>
                <span class="grow" />
                <OnlyYou />
              </div>
              <p class="assistant-place-bar__note" role="status">
                <i class="ti ti-lock-off" aria-hidden="true" />
                <span>
                  {state().view.title ? t().gone({ title: state().view.title! }) : t().goneUnnamed} {t().goneHint}
                </span>
              </p>
            </>
          )}
        </Match>
        <Match when={props.state.kind === "switch" && props.state}>
          {(state) => (
            <div class="assistant-place-bar__row">
              <PlaceChip view={state().view} />
              <span class="grow" />
              <Button
                size="xs"
                variant="ai"
                class="assistant-place-bar__switch"
                disabled={state().disabled || state().busy}
                onClick={() => state().onSwitch()}
              >
                <span class="truncate">
                  {placeTitle(state().view) ? t().switchTo({ title: placeTitle(state().view)! }) : t().switchToUnnamed}
                </span>
              </Button>
            </div>
          )}
        </Match>
        <Match when={props.state.kind === "loading"}>
          <div class="assistant-place-bar__row">
            <Skeleton class="assistant-place-bar__skeleton" />
            <span class="grow" />
            <span role="status" class="sr-only">
              {t().loading}
            </span>
          </div>
          {/* The chip row's place, so the loaded place moves nothing below in the usual one-line case. */}
          <div class="assistant-place-bar__chips" aria-hidden="true">
            <Skeleton class="assistant-place-bar__skeleton-chip" />
            <Skeleton class="assistant-place-bar__skeleton-chip" />
            <Skeleton class="assistant-place-bar__skeleton-chip" />
          </div>
        </Match>
        <Match when={props.state.kind === "failed" && props.state}>
          {(state) => (
            <div class="assistant-place-bar__row" role="alert">
              <i class="ti ti-alert-circle text-danger" aria-hidden="true" />
              <span class="assistant-place-bar__failed">{t().failed}</span>
              <span class="grow" />
              <Button size="xs" variant="ghost" onClick={() => state().onRetry()}>
                {t().retry}
              </Button>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function PlaceChips(props: { view: Available }) {
  const locale = useLocale();
  const t = () => placeMessages.resolve([locale()]).t;
  return (
    <div class="assistant-place-bar__chips">
      <For each={props.view.tools}>
        {(tool) => (
          <Tag size="sm" icon={tool.icon ?? "ti ti-tool"}>
            {tool.title}
          </Tag>
        )}
      </For>
      <For each={props.view.skills}>
        {(skill) => (
          <Tag size="sm" icon="ti ti-sparkles">
            {t().skill({ title: skill.title })}
          </Tag>
        )}
      </For>
      <Tag size="sm" icon="ti ti-file-text">
        {t().contextOf({ type: props.view.typeTitle })}
      </Tag>
    </div>
  );
}

/** "What Gustav can also do here": every extra tool with when it asks, the place's knowledge, and the normal rest. */
function WhatHere(props: { view: Available; onClose: () => void }) {
  const locale = useLocale();
  const t = () => placeMessages.resolve([locale()]).t;
  const policyLine = (policy: Available["tools"][number]["policy"]): string => {
    const text = placePolicyText(policy);
    const reach =
      text.reach === "you" ? t().reachYou : text.reach === "draft" ? t().reachDraft : text.reach === "shared" ? t().reachShared : null;
    const asks = text.asks === "once" ? t().asksOnce : text.asks === "always" ? t().asksAlways : null;
    return [reach, asks].filter(Boolean).join(" · ");
  };
  const Section = (section: { title: string; children: JSX.Element }) => (
    <section class="assistant-place-what__section">
      <h3 class="assistant-place-what__heading">{section.title}</h3>
      <ul class="assistant-place-what__list">{section.children}</ul>
    </section>
  );
  return (
    <div class="assistant-place-what">
      <div class="assistant-place-what__head">
        <h2 class="assistant-place-what__title">{t().whatHereTitle}</h2>
        <IconButton size="xs" label={t().close} onClick={() => props.onClose()}>
          <i class="ti ti-x" aria-hidden="true" />
        </IconButton>
      </div>
      <Section title={t().whatHereFrom({ app: props.view.app.name })}>
        <For each={props.view.tools} fallback={<li class="assistant-place-what__muted">{t().noTools}</li>}>
          {(tool) => (
            <li>
              <i class={tool.icon ?? "ti ti-tool"} aria-hidden="true" />
              <span>
                {tool.title}
                <Show when={policyLine(tool.policy)}>{(line) => <small>{line()}</small>}</Show>
              </span>
            </li>
          )}
        </For>
      </Section>
      <Section title={t().knowledge}>
        <For each={props.view.skills}>
          {(skill) => (
            <li>
              <i class="ti ti-sparkles" aria-hidden="true" />
              <span>{t().skill({ title: skill.title })}</span>
            </li>
          )}
        </For>
        <li>
          <i class="ti ti-file-text" aria-hidden="true" />
          <span>{t().contextHint({ type: props.view.typeTitle, title: props.view.title })}</span>
        </li>
      </Section>
      <Section title={t().asAlways}>
        <li>
          <i class="ti ti-apps" aria-hidden="true" />
          <span>{t().asAlwaysText}</span>
        </li>
      </Section>
    </div>
  );
}
