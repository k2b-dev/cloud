import { markHintSeen } from "@k2b/cloud/browser/hints";
import { AppWorkspace, IconButton, MovedHint, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { overviewMessages } from "../../../overview-messages";
import { useSpaceMessages } from "../../messages";
import { setPinnedSpaceIds } from "../settings/SpaceSettingsStore";
import {
  createNewSpace,
  orderSidebarSpaces,
  type SidebarSpace,
  type SpacesSidebarCurrent,
  type SpacesSidebarData,
} from "./spaces-navigation";

export type { SidebarSpace, SpacesSidebarData } from "./spaces-navigation";
export type SpacesSidebarProps = SpacesSidebarData & {
  current: SpacesSidebarCurrent;
  canCreate: boolean;
  hint?: { id: "spaces.sidebar-switch" | "spaces.overview-sidebar"; open: boolean };
};

export default function SpacesSidebarList(props: SpacesSidebarProps) {
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const messages = useSpaceMessages();
  const [pinned, setPinned] = createSignal(props.pinnedSpaceIds);
  const [announcement, setAnnouncement] = createSignal("");
  const [hintOpen, setHintOpen] = createSignal(Boolean(props.hint?.open));
  const spaces = createMemo(() => orderSidebarSpaces(props.spaces, pinned()));
  const create = createNewSpace(t);
  let body: HTMLDivElement | undefined;
  const dismissHint = () => {
    if (props.hint) markHintSeen(props.hint.id);
    setHintOpen(false);
  };
  const visitSpace = () => {
    markHintSeen("spaces.sidebar-switch");
    markHintSeen("spaces.overview-sidebar");
    setHintOpen(false);
  };
  const togglePin = (space: SidebarSpace) => {
    const wasPinned = pinned().includes(space.id);
    const next = wasPinned ? pinned().filter((id) => id !== space.id) : [space.id, ...pinned()];
    setPinnedSpaceIds(next);
    setPinned(next);
    setAnnouncement(wasPinned ? t.unpinned({ name: space.name }) : t.pinned({ name: space.name }));
  };
  const count = (value: number) => (
    <span class="spaces-overview-count" data-zero={value === 0 ? "true" : undefined}>
      <span aria-hidden="true">{value.toLocaleString(locale())}</span>
      <span class="sr-only">{t.openItemCount({ count: value })}</span>
    </span>
  );
  return (
    <div ref={body} class="spaces-sidebar-list flex min-h-0 flex-1 flex-col">
      <AppWorkspace.SidebarBody scrollPreserveKey="spaces-sidebar">
        <AppWorkspace.SidebarSection title="Spaces">
          <AppWorkspace.SidebarItem
            href="/app/spaces"
            icon="ti ti-checkbox"
            active={props.current.kind === "overview"}
            meta={count(props.myWorkCount)}
          >
            <AppWorkspace.SidebarItemLabel marquee={false}>{t.myWork}</AppWorkspace.SidebarItemLabel>
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarSection>
        <Show when={props.hint?.id === "spaces.overview-sidebar"}>
          <MovedHint
            open={hintOpen()}
            placement="right"
            target={() => body?.querySelector<HTMLElement>("h2") ?? undefined}
            onDismiss={dismissHint}
            action={{ label: t.newSpace, onClick: () => void create() }}
          >
            {messages.sidebarHintOverview}
          </MovedHint>
        </Show>
        <AppWorkspace.SidebarSection>
          <For each={spaces()}>
            {(space) => {
              const isPinned = () => pinned().includes(space.id);
              return (
                <>
                  <AppWorkspace.SidebarItem
                    href={`/app/spaces/${space.id}`}
                    title={space.description || space.name}
                    active={props.current.kind === "space" && props.current.id === space.id}
                    class="spaces-overview-space"
                    data={{ pinned: isPinned() ? "true" : undefined, "space-id": space.id }}
                    onClick={visitSpace}
                    actions={
                      <AppWorkspace.SidebarItemActions visibility="hover">
                        <IconButton
                          label={isPinned() ? t.unpin({ name: space.name }) : t.pin({ name: space.name })}
                          tooltip={isPinned() ? t.unpin({ name: space.name }) : t.pin({ name: space.name })}
                          size="xs"
                          variant="text"
                          aria-pressed={isPinned()}
                          onClick={() => togglePin(space)}
                        >
                          <i class={`ti ${isPinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
                        </IconButton>
                      </AppWorkspace.SidebarItemActions>
                    }
                  >
                    <AppWorkspace.SidebarItemIcon>
                      <Show
                        when={isPinned()}
                        fallback={<span class="spaces-overview-space-dot" style={{ "background-color": space.color }} />}
                      >
                        <i class="ti ti-flag" style={{ color: space.color }} />
                      </Show>
                    </AppWorkspace.SidebarItemIcon>
                    <AppWorkspace.SidebarItemLabel marquee={false}>{space.name}</AppWorkspace.SidebarItemLabel>
                    <AppWorkspace.SidebarItemMeta>{count(space.openItemCount)}</AppWorkspace.SidebarItemMeta>
                  </AppWorkspace.SidebarItem>
                  <Show
                    when={props.hint?.id === "spaces.sidebar-switch" && props.current.kind === "space" && props.current.id === space.id}
                  >
                    <MovedHint
                      open={hintOpen()}
                      placement="right"
                      target={() => body?.querySelector<HTMLElement>("[aria-current=page][href]") ?? undefined}
                      onDismiss={dismissHint}
                      action={{ label: t.myWork, href: "/app/spaces" }}
                    >
                      {messages.sidebarHintSwitch}
                    </MovedHint>
                  </Show>
                </>
              );
            }}
          </For>
          <Show when={props.canCreate}>
            <AppWorkspace.SidebarItem icon="ti ti-plus" onClick={() => void create()}>
              {t.newSpace}
            </AppWorkspace.SidebarItem>
          </Show>
        </AppWorkspace.SidebarSection>
        <span class="sr-only" aria-live="polite">
          {announcement()}
        </span>
      </AppWorkspace.SidebarBody>
    </div>
  );
}
