import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { CloudAvatar } from "../account/Avatar";
import { accessMessages } from "./messages";
import { serviceAccountKindDisplay } from "./service-account-kind";

export { createGroupCoverage, type GroupCoverage } from "./group-coverage";

import { type GroupCoverage, PAGE_SIZE } from "./group-coverage";

const firstPage = (coverage: GroupCoverage) => coverage.members.pages()[0];

/**
 * The members toggle beside the group name. Its label never changes, so
 * loading the members moves nothing in the row; the count leads the list.
 */
export function GroupCoverageToggle(props: { coverage: GroupCoverage; groupName: string; disabled?: boolean }) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-expanded={props.coverage.open()}
      aria-controls={props.coverage.panelId}
      // The group name tells several group rows apart.
      aria-label={t().groupMembersOf({ name: props.groupName })}
      onClick={() => props.coverage.setOpen(!props.coverage.open())}
      // The size sits on the children: the scoped button normalization resets the button's own font.
      class="focus-ui flex items-center gap-0.5 self-center rounded text-dimmed transition-colors hover:text-secondary"
    >
      <span class="text-xs">{t().groupMembers}</span>
      <i
        class="ti ti-chevron-down shrink-0 text-[10px] motion-safe:transition-transform"
        classList={{ "rotate-180": props.coverage.open() }}
        aria-hidden="true"
      />
    </button>
  );
}

/** The expanded member list. It stays in the document while collapsed so `aria-controls` always resolves. */
export function GroupCoveragePanel(props: { coverage: GroupCoverage; groupName: string }) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const members = () => props.coverage.members;
  const shown = () =>
    members()
      .pages()
      .flatMap((page) => (page.visible ? page.members : []));
  const total = () => {
    const page = firstPage(props.coverage);
    return page?.visible ? page.total : null;
  };
  const remaining = () => Math.max((total() ?? 0) - shown().length, 0);
  let panel: HTMLDivElement | undefined;
  let list: HTMLUListElement | undefined;
  let more: HTMLButtonElement | undefined;
  let retry: HTMLButtonElement | undefined;
  // A loading button is disabled, which drops keyboard focus, and the buttons leave on a failure or once
  // everything is shown. Unless the viewer has moved on, focus continues where they can act next.
  const settleFocus = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !panel?.contains(active)) return;
    const next = members().error() ? retry : members().hasMore() ? more : list;
    if (next?.isConnected) next.focus();
  };
  const showMore = async () => {
    await members().loadMore();
    settleFocus();
  };
  const tryAgain = async () => {
    await members().refresh();
    settleFocus();
  };

  return (
    // Indented to the name column: avatar (1.75rem) plus the row gap (0.5rem).
    <div ref={panel} id={props.coverage.panelId} hidden={!props.coverage.open()} class="flex flex-col gap-2 pb-2 pl-9">
      <Show when={members().pages().length === 0 && !members().error()}>
        <InlineGuidance loading>{t().groupMembersLoading}</InlineGuidance>
      </Show>
      <Show when={firstPage(props.coverage)?.visible === false}>
        <InlineGuidance icon="ti ti-eye-off">{t().groupMembersHidden}</InlineGuidance>
      </Show>
      <Show when={total() !== null}>
        <p class="text-sm text-dimmed">{t().groupMemberCount({ count: total() ?? 0 })}</p>
      </Show>
      <Show when={firstPage(props.coverage)?.directoryGroup}>
        <InlineGuidance icon="ti ti-info-circle">{t().directoryGroupHint}</InlineGuidance>
      </Show>
      <Show when={shown().length > 0}>
        <ul ref={list} tabindex="-1" aria-label={t().groupMembersOf({ name: props.groupName })} class="flex flex-col gap-1 outline-none">
          <For each={shown()}>
            {(member) => {
              if (member.kind === "service_account") {
                const kind = () => serviceAccountKindDisplay(member.serviceAccount.kind, t());
                return (
                  <li class="flex min-w-0 items-center gap-2 text-sm">
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full not-dark:bg-zinc-200 text-secondary dark:bg-zinc-700">
                      <i class={`ti ${kind().icon}`} aria-hidden="true" />
                    </span>
                    <span class="truncate">{member.serviceAccount.name}</span>
                    <span class="shrink-0 text-xs text-muted">{kind().label}</span>
                  </li>
                );
              }
              const user = member.user;
              const name = user.displayName || user.mail || user.uid;
              return (
                <li class="flex min-w-0 items-center gap-2 text-sm">
                  <CloudAvatar username={name} userId={user.id} avatarHash={user.avatarHash} size="xs" class="h-6 w-6 shrink-0" />
                  <span class="truncate">{name}</span>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={members().error()}>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
          <span>{t().groupMembersFailed}</span>{" "}
          <Button ref={retry} variant="text" size="xs" onClick={() => void tryAgain()}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={members().hasMore() && !members().error()}>
        <Button ref={more} variant="text" size="xs" class="self-start" loading={members().loadingMore()} onClick={() => void showMore()}>
          {t().showMoreMembers({ count: Math.min(remaining(), PAGE_SIZE) })}
        </Button>
      </Show>
    </div>
  );
}
