import { markHintSeen } from "@k2b/cloud/browser/hints";
import type { DateContext } from "@k2b/stdlib";
import { Dropdown, type DropdownItem, MovedHint, toast, watchAppHostWidth } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import type { SpaceAssignableUser } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import SearchButton from "../search/SearchButton";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import { createIcalCopy } from "../sidebar/CopyICalButton";
import { createSpaceSettings } from "../sidebar/SpaceSettingsButton";
import { createKanbanShortcuts } from "./kanban-shortcuts";

type Props = {
  spaceId: string;
  spaceName: string;
  icalToken: string | null;
  baseUrl: string;
  dateConfig?: DateContext;
  currentView: "list" | "table" | "kanban" | "calendar";
  canWrite: boolean;
  people: SpaceAssignableUser[];
  hintOpen?: boolean;
};

export default function SpaceHeadActions(props: Props) {
  const t = useSpaceMessages();
  const settings = createSpaceSettings(props);
  const calendar = createIcalCopy(props);
  const shortcuts = createKanbanShortcuts(props);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [includePeople, setIncludePeople] = createSignal(false);
  const [hintOpen, setHintOpen] = createSignal(props.hintOpen ?? false);
  let trigger: HTMLButtonElement | undefined;
  let stopWidthWatch: (() => void) | undefined;
  const dismissHint = () => {
    markHintSeen("spaces.space-menu");
    setHintOpen(false);
  };
  const openMenu = (open: boolean) => {
    stopWidthWatch?.();
    stopWidthWatch = undefined;
    if (open) {
      dismissHint();
      if (trigger) stopWidthWatch = watchAppHostWidth(trigger, 80, (wide) => setIncludePeople(!wide));
    }
    setMenuOpen(open);
  };
  onCleanup(() => stopWidthWatch?.());

  const items = (): DropdownItem[] => [
    { label: t.spaceSettings, icon: "ti ti-settings", action: () => void settings.openDialog() },
    ...(props.icalToken
      ? [
          {
            label: calendar.copied() ? t.copiedIcalUrl : t.copyIcalUrl,
            icon: calendar.copied() ? "ti ti-check" : "ti ti-calendar-share",
            immediate: true,
            action: () => void calendar.handleCopy().catch(() => toast.error(t.headCopyFailed)),
          },
        ]
      : []),
    ...(props.currentView === "kanban" ? [{ label: t.keyboardShortcuts, icon: "ti ti-keyboard", action: () => void shortcuts() }] : []),
    ...(includePeople() && props.people.length > 0
      ? [
          {
            sectionLabel: t.headPeople,
            items: props.people.map((person) => ({
              label: person.displayName,
              icon: person.kind === "service_account" ? "ti ti-api" : "ti ti-user",
              disabled: true as const,
            })),
          },
        ]
      : []),
  ];

  return (
    <>
      <Show when={props.people.length > 0}>
        <div
          data-spaces-people-row
          role="group"
          aria-label={t.headSpacePeople({ names: props.people.map((person) => person.displayName).join(", ") })}
        >
          <AssigneeAvatars assignees={props.people} max={4} />
        </div>
      </Show>
      <SearchButton spaceId={props.spaceId} spaceName={props.spaceName} variant="icon" registerCommand />
      <Dropdown.Root items={items()} open={menuOpen()} onOpenChange={openMenu} label={t.headSpaceMenu} position="bottom-right">
        <Dropdown.Trigger ref={trigger} iconOnly label={t.headSpaceMenu} variant="ghost" data-spaces-menu>
          <i class="ti ti-dots" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <MovedHint
        open={hintOpen()}
        target={() => trigger}
        onDismiss={dismissHint}
        action={{ label: t.headOpenMenu, onClick: () => openMenu(true) }}
      >
        {t.headMenuHint({ ical: Boolean(props.icalToken), shortcuts: props.currentView === "kanban" })}
      </MovedHint>
      <span class="sr-only" role="status">
        {calendar.copied() ? t.copiedIcalUrl : ""}
      </span>
    </>
  );
}
