import { useLocale } from "@k2b/ui";
import { Button, Dialog, Facts } from "@k2b/ui/v2";
import { openDialog } from "../../../lib/open-dialog";
import { useSpaceMessages } from "../../messages";

/** The board's shortcuts, from the Space menu for pointer and keyboard alike. */
export function createKanbanShortcuts(props: { canWrite: boolean }) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const arrows = "← ↑ → ↓";
  return () =>
    openDialog<void>(locale(), (close) => (
      <Dialog
        title={t.keyboardShortcuts}
        open
        onOpenChange={(open) => !open && close()}
        foot={<Button onClick={() => close()}>{t.close}</Button>}
      >
        {/* k2b-ui gap: v2 has no key caps yet; each key stands as its sign in the fact's label. */}
        <Facts
          items={[
            { label: arrows, value: t.kanbanShortcutNavigate },
            { label: "Enter", value: t.kanbanShortcutOpen },
            ...(props.canWrite
              ? [
                  { label: "M", value: t.kanbanShortcutAssign },
                  { label: "D", value: t.kanbanShortcutComplete },
                  { label: `Space, ${arrows}, Esc`, value: t.kanbanShortcutMove },
                ]
              : []),
          ]}
        />
      </Dialog>
    ));
}
