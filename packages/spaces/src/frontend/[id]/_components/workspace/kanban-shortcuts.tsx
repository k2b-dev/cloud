import { Kbd, prompts } from "@k2b/ui";
import { For } from "solid-js";
import { useSpaceMessages } from "../../messages";

/** The board's shortcuts are available by pointer and keyboard from the Space menu. */
export function createKanbanShortcuts(props: { canWrite: boolean }) {
  const t = useSpaceMessages();
  return () =>
    prompts.dialog<void>(
      () => (
        <div class="flex flex-col gap-2 text-sm">
          <p class="text-xs text-dimmed">{t.kanbanShortcutsTitle}</p>
          <For
            each={[
              { keys: ["arrowleft", "arrowup", "arrowright", "arrowdown"], label: t.kanbanShortcutNavigate },
              { keys: ["enter"], label: t.kanbanShortcutOpen },
              ...(props.canWrite
                ? [
                    { keys: ["m"], label: t.kanbanShortcutAssign },
                    { keys: ["d"], label: t.kanbanShortcutComplete },
                    { keys: ["space", "arrowleft", "arrowup", "arrowright", "arrowdown", "escape"], label: t.kanbanShortcutMove },
                  ]
                : []),
            ]}
          >
            {(shortcut) => (
              <div class="flex items-center justify-between gap-4">
                <span>{shortcut.label}</span>
                <span class="flex gap-1">
                  <For each={shortcut.keys}>{(key) => <Kbd keys={key} />}</For>
                </span>
              </div>
            )}
          </For>
        </div>
      ),
      { title: t.keyboardShortcuts, icon: "ti ti-keyboard", size: "small" },
    );
}
