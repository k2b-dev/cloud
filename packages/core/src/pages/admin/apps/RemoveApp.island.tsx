import { Button, useLocale } from "@k2b/ui";
import { openRemoveDialog } from "./remove-dialog";

/** "Remove from list …" as a hint's way out or in the last row of the app detail; both open the same confirmation. */
export default function RemoveApp(props: { app: { id: string; name: string }; variant: "button" | "row"; label: string }) {
  const locale = useLocale();
  const open = () => void openRemoveDialog(props.app, locale());
  // In the detail's last row it stays quiet; the confirmation carries the danger.
  return props.variant === "row" ? (
    <Button size="xs" variant="ghost" onClick={open} data-row="remove">
      {props.label}
    </Button>
  ) : (
    <Button size="sm" variant="secondary" onClick={open}>
      {props.label}
    </Button>
  );
}
