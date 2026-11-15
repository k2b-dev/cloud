import type { AiProject } from "@k2b/cloud/ai";
import { Dropdown, type DropdownAction, type DropdownItem, type DropdownSearch, formatFileViewSize, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { appTab, contextTab, fileTab, presentationTab, type WorkspaceTab } from "../artifacts/workspace-state";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { addMenuMessages } from "./add-menu-messages";
import { contextBoxResultRow } from "./chat-context-box";
import { chatSidebarMessages } from "./chat-sidebar-messages";

/** Opens the menu beside `from`; a tab it opens joins the group of the Panes item `beside`, or the first pane. */
export type AssistantAddMenuOpen = (from: HTMLElement, beside: string | null) => void;

type Stage = "menu" | "results";

/**
 * The menu behind every "+" beside a chat (Feinschliff v3, section 6): one menu for the + in the box's head and the +
 * at the end of each row of tabs. It offers only what Gustav has: a result of this chat and the chat's files. A result
 * among several opens in its place, as a search; Esc leads back to the menu. A letter chooses an entry while the menu is open; a phone gets it as a sheet.
 */
export function AssistantAddMenu(props: {
  chatId: string | null;
  project?: AiProject | null;
  snapshot: () => AssistantChatContextSnapshot | null;
  openTab: (tab: WorkspaceTab, beside: string | null) => void;
  register: (open: AssistantAddMenuOpen) => void;
}) {
  const locale = useLocale();
  const t = () => addMenuMessages.resolve([locale()]).t;
  const [stage, setStage] = createSignal<Stage>("menu");
  let openAt: ((anchor: HTMLElement, returnFocus: HTMLElement) => void) | undefined;
  let from: HTMLElement | undefined;
  let beside: string | null = null;
  // Esc in a search leads back to the menu; any other way out closes it.
  let escaped = false;
  // Set while a choice moves the menu to its next step, so its closing is not an end.
  let moving = false;

  const results = () =>
    (props.snapshot()?.results ?? []).toSorted(
      (a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt) || a.key.localeCompare(b.key),
    );
  const open = (tab: WorkspaceTab | null) => {
    if (tab) props.openTab(tab, beside);
  };
  const show = (next: Stage) => {
    moving = true;
    setStage(next);
    // After the menu closed for the choice, the same place opens the next step.
    queueMicrotask(() => {
      if (from?.isConnected) openAt?.(from, from);
      moving = false;
    });
  };
  const resultRows = (): DropdownAction[] => {
    const snapshot = props.snapshot();
    const chatId = props.chatId;
    if (!snapshot || !chatId) return [];
    return results().flatMap((result) => {
      const row = contextBoxResultRow(result, {
        now: snapshot.now,
        timeZone: snapshot.timeZone,
        locale: locale(),
        formatSize: (bytes) => formatFileViewSize(bytes, locale()),
        copy: { showInChat: chatSidebarMessages.resolve([locale()]).t.showInChat },
      });
      const target = row.open;
      const tab =
        target.kind === "file"
          ? { ...fileTab(chatId, target.path), title: target.title }
          : target.kind === "app"
            ? appTab(target.id, target.title)
            : target.kind === "presentation"
              ? presentationTab(chatId, target.id, target.title)
              : null;
      return tab ? [{ label: row.title, icon: row.icon, trailing: row.trailing, action: () => open(tab) }] : [];
    });
  };
  const menuEntries = (): DropdownAction[] => {
    const chatId = props.chatId;
    if (!chatId) return [];
    const copy = t();
    const found = resultRows();
    return [
      {
        label: copy.result,
        icon: "ti ti-table",
        key: "E",
        disabled: found.length === 0,
        description: found.length === 0 ? copy.resultNone : undefined,
        action: () => (found.length === 1 ? found[0]!.action() : show("results")),
      },
      {
        label: copy.files,
        icon: "ti ti-paperclip",
        key: "D",
        action: () => open(contextTab(chatId, "files", chatSidebarMessages.resolve([locale()]).t.title, props.project)),
      },
    ];
  };
  const items = (): DropdownItem[] => {
    if (stage() === "results") return resultRows();
    return menuEntries();
  };
  const search = (): DropdownSearch | undefined => {
    const copy = t();
    if (stage() === "results") return { label: copy.resultsSearch({ count: resultRows().length }) };
    return undefined;
  };

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") escaped = true;
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
    props.register((element, target) => {
      from = element;
      beside = target;
      escaped = false;
      setStage("menu");
      // With only one thing to add, the + opens it directly.
      const entries = menuEntries();
      if (entries.length === 1 && !entries[0]!.disabled) return entries[0]!.action();
      openAt?.(element, element);
    });
  });

  return (
    <Dropdown
      items={items()}
      search={search()}
      heading={stage() === "menu" ? t().open : t().resultsHeading}
      keyHint={stage() === "menu" ? [t().keysMove, t().keysLetter] : [t().keysMove, t().keysBack]}
      label={t().open}
      position="bottom-left"
      phone="sheet"
      menuClass="assistant-add-menu"
      openAt={(open) => {
        openAt = open;
      }}
      onOpenChange={(isOpen) => from?.setAttribute("aria-expanded", String(isOpen))}
      onClose={() => {
        if (moving) return;
        const back = escaped && stage() !== "menu";
        escaped = false;
        if (back) show("menu");
        else queueMicrotask(() => setStage("menu"));
      }}
    />
  );
}
