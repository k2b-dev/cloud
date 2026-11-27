import { AppWorkspace, IconButton, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { hexColor } from "@/frontend/lib/color";
import { overviewMessages } from "../../../overview-messages";
import { setPinnedSpaceIds } from "../settings/SpaceSettingsStore";
import {
  createNewSpace,
  createPinnedSpaces,
  orderSidebarSpaces,
  type SidebarSpace,
  type SpacesSidebarCurrent,
  type SpacesSidebarData,
} from "./spaces-navigation";

export type { SidebarSpace, SpacesSidebarData } from "./spaces-navigation";
export type SpacesSidebarProps = SpacesSidebarData & {
  current: SpacesSidebarCurrent;
  canCreate: boolean;
};

export default function SpacesSidebarList(props: SpacesSidebarProps) {
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const [pinned, setPinned] = createPinnedSpaces(props.pinnedSpaceIds);
  const [announcement, setAnnouncement] = createSignal("");
  const spaces = createMemo(() => orderSidebarSpaces(props.spaces, pinned()));
  const create = createNewSpace(t);
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
    <div class="spaces-sidebar-list flex min-h-0 flex-1 flex-col">
      <AppWorkspace.SidebarBody scrollPreserveKey="spaces-sidebar">
        <AppWorkspace.SidebarSection title="Spaces">
          <AppWorkspace.SidebarItem
            href="/app/spaces"
            // The collapsed rail hides the label; the title names the row there.
            title={t.myWork}
            icon="ti ti-checkbox"
            active={props.current.kind === "overview"}
            meta={count(props.myWorkCount)}
          >
            <AppWorkspace.SidebarItemLabel marquee={false}>{t.myWork}</AppWorkspace.SidebarItemLabel>
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarItem
            href="/app/spaces/calendar"
            title={t.calendar}
            icon="ti ti-calendar"
            active={props.current.kind === "calendar"}
          >
            <AppWorkspace.SidebarItemLabel marquee={false}>{t.calendar}</AppWorkspace.SidebarItemLabel>
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarSection>
        <AppWorkspace.SidebarSection>
          <For each={spaces()}>
            {(space) => {
              const isPinned = () => pinned().includes(space.id);
              const title = space.description ? `${space.name}: ${space.description}` : space.name;
              const active = () => props.current.kind === "space" && props.current.id === space.id;
              const icon = () => (
                <AppWorkspace.SidebarItemIcon>
                  <Show
                    when={isPinned()}
                    fallback={<span class="spaces-overview-space-dot" style={{ "background-color": hexColor(space.color) }} />}
                  >
                    <i class="ti ti-flag" style={{ color: hexColor(space.color) }} />
                  </Show>
                </AppWorkspace.SidebarItemIcon>
              );
              return (
                <>
                  <AppWorkspace.SidebarItem
                    sidebarMode="expanded"
                    href={`/app/spaces/${space.id}`}
                    title={title}
                    active={active()}
                    class="spaces-overview-space"
                    data={{ pinned: isPinned() ? "true" : undefined, "space-id": space.id }}
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
                    {icon()}
                    <AppWorkspace.SidebarItemLabel marquee={false}>{space.name}</AppWorkspace.SidebarItemLabel>
                    <AppWorkspace.SidebarItemMeta>{count(space.openItemCount)}</AppWorkspace.SidebarItemMeta>
                  </AppWorkspace.SidebarItem>
                  {/* The collapsed rail hides labels and row actions. A row with a pin action names its wrapper, not its
                      link, so the rail gets a plain row whose link carries the name. */}
                  <AppWorkspace.SidebarItem
                    sidebarMode="collapsed"
                    href={`/app/spaces/${space.id}`}
                    title={title}
                    active={active()}
                  >
                    {icon()}
                    <AppWorkspace.SidebarItemLabel marquee={false}>{space.name}</AppWorkspace.SidebarItemLabel>
                  </AppWorkspace.SidebarItem>
                </>
              );
            }}
          </For>
          <Show when={props.canCreate}>
            <AppWorkspace.SidebarItem icon="ti ti-plus" title={t.newSpace} onClick={() => void create()}>
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
