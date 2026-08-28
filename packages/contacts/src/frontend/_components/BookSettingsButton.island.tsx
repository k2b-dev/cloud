import { refreshCurrentPath } from "@k2b/ssr/nav";
import { IconButton, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { bookMessages } from "./book-messages";
import { openBookSettingsDialog } from "./BookSettingsDialog";

export default function BookSettingsButton(props: { bookId: string; bookName: string }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);

  const openSettings = async () => {
    if (open()) return;
    setOpen(true);
    try {
      const result = await openBookSettingsDialog({ bookId: props.bookId });
      if (result.workspaceChanged && !result.deleted) refreshCurrentPath();
    } finally {
      setOpen(false);
    }
  };

  return (
    <IconButton
      size="xs"
      variant="ghost"
      label={t().openSettingsFor({ name: props.bookName })}
      disabled={open()}
      onClick={() => void openSettings()}
    >
      <i class={open() ? "ti ti-loader-2 animate-spin" : "ti ti-settings"} aria-hidden="true" />
    </IconButton>
  );
}
