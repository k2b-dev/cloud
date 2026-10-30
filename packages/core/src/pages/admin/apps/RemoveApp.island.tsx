import { AppWorkspace, Button, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { openRemoveDialog } from "./remove-dialog";

/** "Remove from list …" as a hint's way out or as the last row of the app page; both open the same confirmation. */
export default function RemoveApp(props: { app: { id: string; name: string }; variant: "button" | "row"; label: string }) {
  const locale = useLocale();
  const open = () => void openRemoveDialog(props.app, locale());
  return (
    <Show
      when={props.variant === "row"}
      fallback={
        <Button size="sm" variant="secondary" onClick={open}>
          {props.label}
        </Button>
      }
    >
      <AppWorkspace.SidebarItem icon="ti ti-trash" tone="danger" onClick={open} data={{ row: "remove" }}>
        {props.label}
      </AppWorkspace.SidebarItem>
    </Show>
  );
}
