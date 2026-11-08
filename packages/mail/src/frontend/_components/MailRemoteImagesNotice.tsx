import { Button, Dropdown, type DropdownItem, NoticeCard, SplitButton } from "@k2b/ui";
import { createEffect, createMemo, Match, on, Show, Switch } from "solid-js";
import type { RemoteContentAllowRule } from "../../service/remote-content";
import type { mailMessageMessages } from "./mail-message-messages";

/**
 * What the external-images row shows. `blocked`, `loading`, `failed`, and `limited` sit on a tinted notice; `once` and
 * `always` are a quiet line after the images are shown. Every kind keeps the same 48px row, so the message never moves.
 */
export type RemoteImagesNoticeKind = "blocked" | "loading" | "failed" | "limited" | "once" | "always";

type Messages = ReturnType<typeof mailMessageMessages.resolve>["t"];

/** Marks the control that takes the focus back after the row changes. */
const ACTION = "data-remote-images-action";

export default function MailRemoteImagesNotice(props: {
  kind: RemoteImagesNoticeKind;
  messages: Messages;
  locale: string;
  loaded: number;
  total: number;
  /** The one sender of the message; several senders get no "always" choices. */
  sender: string | null;
  domain: string | null;
  /** The reader's own rules that load these images automatically. */
  rules: readonly RemoteContentAllowRule[];
  /** A rule is being saved or removed. */
  busy: boolean;
  /** What a screen reader hears after the row changes. */
  announcement: string;
  onLoad: () => void;
  onAllow: (rule: { scope: "sender" | "domain"; value: string }) => void;
  onRevoke: () => void;
  onOpenRules: () => void;
}) {
  const t = () => props.messages;
  let section: HTMLElement | undefined;
  // A change the person started in this row brings the focus back to the row's control, so it is not lost when the
  // pressed button goes away or waits disabled.
  let returnFocus = false;
  const act =
    <T extends unknown[]>(run: (...args: T) => void) =>
    (...args: T) => {
      returnFocus = true;
      run(...args);
    };
  createEffect(
    on(
      () => props.kind,
      (kind) => {
        if (!returnFocus || !section) return;
        const active = document.activeElement;
        if (active && active !== document.body && !section.contains(active)) {
          returnFocus = false;
          return;
        }
        if (kind !== "loading") returnFocus = false;
        requestAnimationFrame(() => {
          if (!section?.isConnected) return;
          const target = kind === "loading" ? null : section.querySelector<HTMLElement>(`[${ACTION}]:not(:disabled)`);
          (target ?? section).focus();
        });
      },
      { defer: true },
    ),
  );

  const allowItems = (): DropdownItem[] => {
    const sender = props.sender;
    const domain = props.domain;
    const choices = [
      ...(sender
        ? [
            {
              label: t().alwaysFromSender({ sender }),
              icon: "ti ti-user",
              action: act(() => props.onAllow({ scope: "sender", value: sender })),
            },
          ]
        : []),
      ...(domain
        ? [
            {
              label: t().alwaysFromDomain({ domain }),
              icon: "ti ti-world",
              action: act(() => props.onAllow({ scope: "domain", value: domain })),
            },
          ]
        : []),
    ];
    return [
      ...(choices.length > 0 ? [{ sectionLabel: t().loadAutomatically, items: choices }] : []),
      { label: t().externalImageRules, icon: "ti ti-settings", action: props.onOpenRules },
    ];
  };
  const revokeItems = (): DropdownItem[] => [
    {
      items: [{ label: t().stopLoadingAutomatically, icon: "ti ti-photo-off", variant: "danger", action: act(props.onRevoke) }],
    },
    { label: t().externalImageRules, icon: "ti ti-settings", action: props.onOpenRules },
  ];
  const ruleNote = createMemo(() => {
    const names = props.rules.map((rule) => (rule.scope === "sender" ? t().ruleSender(rule) : t().ruleDomain(rule)));
    return names.length === 0
      ? undefined
      : t().appliesThroughRules({ rules: new Intl.ListFormat(props.locale, { type: "conjunction" }).format(names), count: names.length });
  });
  const quiet = () => props.kind === "once" || props.kind === "always";
  const loading = () => props.kind === "loading";
  const tile = () =>
    props.kind === "failed"
      ? { icon: "ti ti-photo-x", color: undefined }
      : props.kind === "limited"
        ? { icon: "ti ti-photo-exclamation", color: "var(--k2b-text-muted)" }
        : { icon: "ti ti-photo-shield", color: "var(--k2b-reference-image)" };

  return (
    <section ref={section} aria-label={t().externalImages} tabindex="-1" class="outline-none" data-remote-images={props.kind}>
      <p class="sr-only" aria-live="polite">
        {props.announcement}
      </p>
      <Show
        when={quiet()}
        fallback={
          <NoticeCard
            tone={props.kind === "failed" ? "danger" : "neutral"}
            tile={tile().icon}
            tileColor={tile().color}
            action={
              <Switch>
                <Match when={props.kind === "failed"}>
                  <Button {...{ [ACTION]: "" }} variant="secondary" size="sm" type="button" onClick={act(props.onLoad)}>
                    <i class="ti ti-refresh max-md:hidden" aria-hidden="true" />
                    <span class="max-md:hidden">{t().retryImages}</span>
                    <span class="md:hidden">{t().retryImagesShort}</span>
                  </Button>
                </Match>
                <Match when={props.kind === "limited"}>{null}</Match>
                <Match when={props.sender}>
                  <SplitButton
                    {...{ [ACTION]: "" }}
                    variant="secondary"
                    size="sm"
                    type="button"
                    phone="sheet"
                    loading={loading()}
                    disabled={props.busy}
                    onClick={act(props.onLoad)}
                    menuLabel={t().externalImageOptions}
                    menuNote={t().externalImagesRisk}
                    menuPosition="bottom-right"
                    items={allowItems()}
                  >
                    <i class="ti ti-photo max-md:hidden" aria-hidden="true" />
                    <span class="max-md:hidden">{t().loadImages}</span>
                    <span class="md:hidden">{t().loadImagesShort}</span>
                  </SplitButton>
                </Match>
                <Match when={!props.sender}>
                  <Button
                    {...{ [ACTION]: "" }}
                    variant="secondary"
                    size="sm"
                    type="button"
                    loading={loading()}
                    disabled={props.busy}
                    onClick={act(props.onLoad)}
                  >
                    <i class="ti ti-photo max-md:hidden" aria-hidden="true" />
                    <span class="max-md:hidden">{t().loadImages}</span>
                    <span class="md:hidden">{t().loadImagesShort}</span>
                  </Button>
                </Match>
              </Switch>
            }
          >
            <Switch>
              <Match when={props.kind === "failed"}>
                <p class="m-0 truncate text-primary" role="alert">
                  <strong class="font-semibold max-md:hidden">{t().imagesFailed}</strong>
                  <strong class="font-semibold md:hidden">{t().imagesFailedShort}</strong>
                </p>
              </Match>
              <Match when={props.kind === "limited"}>
                <p class="m-0 truncate">
                  <strong class="font-semibold text-primary">{t().imagesLimited}</strong>
                  <span class="max-md:hidden"> · {t().imagesLimitedReason}</span>
                </p>
              </Match>
              <Match when={loading()}>
                <p class="m-0 truncate">
                  <strong class="font-semibold text-primary max-md:hidden">{t().imagesLoading}</strong>
                  <strong class="font-semibold text-primary md:hidden">{t().imagesLoadingShort}</strong>
                  <span class="max-md:hidden" aria-hidden="true">
                    {" "}
                    · {t().imagesProgress({ loaded: props.loaded, total: props.total })}
                  </span>
                </p>
              </Match>
              <Match when={props.kind === "blocked"}>
                <p class="m-0 truncate">
                  <strong class="font-semibold text-primary">{t().externalImagesBlocked}</strong>
                  <span class="max-md:hidden"> · {t().externalImagesBlockedReason}</span>
                </p>
              </Match>
            </Switch>
          </NoticeCard>
        }
      >
        {/* The quiet line keeps the notice's metrics: the same padding, tile box, and 48px row, without a surface. */}
        <div class="flex min-h-12 items-center gap-3 rounded-[var(--ui-radius-control)] border border-transparent p-[calc(0.5rem-1px)] text-sm leading-[1.375rem] text-secondary max-md:gap-2.5">
          <span
            class="grid size-8 shrink-0 place-items-center text-lg max-md:size-7 max-md:text-base"
            style={{ color: props.kind === "always" ? "var(--k2b-reference-image)" : "var(--k2b-success-text)" }}
            aria-hidden="true"
          >
            <i class="ti ti-photo-check" />
          </span>
          <p class="m-0 min-w-0 flex-1 truncate">
            <Show
              when={props.kind === "always"}
              fallback={
                <>
                  {t().imagesLoaded}
                  <span class="max-md:hidden">{t().imagesLoadedOnce}</span>
                </>
              }
            >
              <Show when={props.sender} fallback={t().imagesAlways}>
                {(sender) => (
                  <>
                    <span class="max-md:hidden">
                      <AlwaysFrom template={t().imagesAlwaysFrom({ sender: SENDER })} sender={sender()} />
                    </span>
                    <span class="md:hidden">{t().imagesAlways}</span>
                  </>
                )}
              </Show>
            </Show>
          </p>
          <Show when={props.kind === "always" || props.sender || props.domain}>
            <Dropdown.Root
              items={props.kind === "always" ? revokeItems() : allowItems()}
              label={t().externalImageOptions}
              note={props.kind === "always" ? ruleNote() : t().externalImagesRisk}
              phone="sheet"
              position="bottom-right"
              disabled={props.busy}
            >
              <Dropdown.Trigger {...{ [ACTION]: "" }} variant="link" size="sm">
                {props.kind === "always" ? t().changeImageRule : t().alwaysLoad}
                <i class="ti ti-chevron-down" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
        </div>
      </Show>
    </section>
  );
}

const SENDER = "{sender}";

/** "Images from <b>sender</b> always load", with the sender in bold wherever the language puts it. */
function AlwaysFrom(props: { template: string; sender: string }) {
  const parts = () => props.template.split(SENDER);
  return (
    <>
      {parts()[0]}
      <b class="font-semibold text-primary">{props.sender}</b>
      {parts()[1]}
    </>
  );
}
