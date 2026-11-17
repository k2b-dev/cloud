import { documentNavigate } from "@k2b/ssr/nav";
import { Button, ButtonLink, Dropdown, type DropdownAction, type DropdownItem, SplitButton } from "@k2b/ui";
import { Show } from "solid-js";
import type { CodePageReady } from "./data";
import { launchPages, pageTitle, runnable, timing } from "./launch";
import { type PageText, sentence } from "./page-kit";
import type { CodeRunAction } from "./run-action";

export const runItems = (state: CodePageReady, text: PageText, run: CodeRunAction): DropdownAction[] =>
  runnable(state).map((automation) => ({
    label: automation.title ?? sentence(timing(automation, text), text.locale()),
    description: run.pending(automation.entrypoint)
      ? text.t().runStartingAction
      : automation.title
        ? sentence(timing(automation, text), text.locale())
        : undefined,
    icon: run.pending(automation.entrypoint) ? "ti ti-loader-2 cloud-code__spin" : "ti ti-player-play",
    disabled: run.pending(automation.entrypoint),
    action: () => run.start(automation),
  }));

/** The approved head decision table; all menus keep Dropdown's keyboard and phone-sheet lifecycle. */
export function CodeLaunch(props: { state: CodePageReady; text: PageText; run: CodeRunAction; secondary: boolean }) {
  const t = props.text.t;
  const pages = () => launchPages(props.state);
  const runs = () => runnable(props.state);
  const ready = () => props.state.code.state === "active" && !!props.state.active && props.state.automations !== null;
  const variant = () => (props.secondary ? ("secondary" as const) : ("primary" as const));
  const items = (): DropdownItem[] => [
    ...(pages().length > 1
      ? [
          {
            sectionLabel: t().launchOtherPages,
            items: pages()
              .slice(1)
              .map((page) => ({
                label: pageTitle(page, props.text),
                icon: "ti ti-browser",
                href: page.href,
              })),
          },
        ]
      : []),
    ...(runs().length ? [{ sectionLabel: t().runNow, items: runItems(props.state, props.text, props.run) }] : []),
  ];
  const open = () => documentNavigate(props.state.pages!.homeUrl!);
  return (
    <Show
      when={ready()}
      fallback={
        <Show when={props.state.code.state === "paused" && props.state.permission === "reader" && pages().length}>
          <Button
            tooltip={t().pagesPaused}
            type="button"
            variant="secondary"
            class="cloud-code__launch"
            aria-disabled="true"
            onClick={(event) => event.preventDefault()}
          >
            <i class="ti ti-browser" aria-hidden="true" />
            {t().launchOpen}
          </Button>
        </Show>
      }
    >
      <Show
        when={pages()[0]}
        fallback={
          <Show when={runs().length > 0}>
            <Show
              when={runs().length > 1}
              fallback={
                <Button
                  type="button"
                  variant={variant()}
                  class="cloud-code__launch"
                  loading={props.run.loading()}
                  onClick={() => props.run.start(runs()[0]!)}
                >
                  <i class="ti ti-player-play" aria-hidden="true" />
                  {t().runNow}
                </Button>
              }
            >
              <Dropdown.Root
                items={runItems(props.state, props.text, props.run)}
                label={t().runNow}
                phone="sheet"
                position="bottom-right"
                class="cloud-code__launch"
              >
                <Dropdown.Trigger type="button" variant={variant()}>
                  <i class="ti ti-player-play" aria-hidden="true" />
                  {t().runNow}
                  <i class="ti ti-chevron-down" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </Show>
          </Show>
        }
      >
        <Show
          when={items().length}
          fallback={
            <ButtonLink variant={variant()} class="cloud-code__launch" href={props.state.pages!.homeUrl!}>
              <i class="ti ti-browser" aria-hidden="true" />
              {t().launchOpen}
            </ButtonLink>
          }
        >
          <SplitButton
            type="button"
            variant={variant()}
            class="cloud-code__launch"
            onClick={open}
            items={items()}
            menuLabel={t().launchMore}
            phone="sheet"
            menuPosition="bottom-right"
          >
            <i class="ti ti-browser" aria-hidden="true" />
            {t().launchOpen}
          </SplitButton>
        </Show>
      </Show>
    </Show>
  );
}

/**
 * The familiar overview entry uses exactly the head's mutation, not its own request or status.
 * Button's future receipt check/cross belongs beside loading here and in the direct head button; run completion stays live/toast.
 */
export function RunNow(props: { state: CodePageReady; text: PageText; run: CodeRunAction }) {
  const t = props.text.t;
  const runs = () => runnable(props.state);
  return (
    <Show when={runs().length}>
      <Show
        when={runs().length > 1}
        fallback={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            class="cloud-code__run-now"
            loading={props.run.loading()}
            onClick={() => props.run.start(runs()[0]!)}
          >
            <i class="ti ti-player-play" aria-hidden="true" />
            {t().runNow}
          </Button>
        }
      >
        <Dropdown.Root items={runItems(props.state, props.text, props.run)} label={t().runNow} position="bottom-right" phone="sheet">
          <Dropdown.Trigger type="button" size="sm" variant="ghost" class="cloud-code__run-now">
            <i class="ti ti-player-play" aria-hidden="true" />
            {t().runNow}
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    </Show>
  );
}
