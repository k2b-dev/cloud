import { dialogCore, useLocale } from "@k2b/ui";
import type { SearchItem } from "../api/search/schemas";
import CloudResourceSearch from "../browser/CloudResourceSearch";
import { type GlobalSearchHelpApp, openGlobalSearchHelpDialog } from "./GlobalSearchHelpDialog";

type GlobalSearchDialogProps = {
  close: () => void;
  helpApps: GlobalSearchHelpApp[];
};

export default function GlobalSearchDialog(props: GlobalSearchDialogProps) {
  const locale = useLocale();
  const openHelp = () => {
    props.close();
    queueMicrotask(() => openGlobalSearchHelpDialog(props.helpApps, locale()));
  };

  const openItem = (item: SearchItem) => {
    props.close();
    window.location.href = item.href;
  };

  return <CloudResourceSearch helpApps={props.helpApps} onHelp={openHelp} onSelect={openItem} />;
}

export const openGlobalSearchDialog = (helpApps: GlobalSearchHelpApp[] = []) => {
  if (dialogCore.isOpen()) return;

  void dialogCore.open<void>((close) => <GlobalSearchDialog close={close} helpApps={helpApps} />, {
    panelClassName:
      "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 m-0 h-[var(--spotlight-dialog-height)] w-[min(var(--ui-dialog-available-width),72rem)] [--spotlight-dialog-height:min(50vh,var(--ui-dialog-available-height))] overflow-hidden overscroll-y-contain rounded-2xl border-0 bg-white/92 p-0 text-zinc-900 shadow-xl ring-1 ring-inset ring-zinc-300/60 backdrop:bg-black/35 backdrop:backdrop-blur-sm dark:bg-zinc-950/92 dark:text-zinc-100 dark:ring-zinc-700/60 [@media(min-height:1100px)]:[--spotlight-dialog-height:min(33vh,var(--ui-dialog-available-height))]",
    contentClassName: "h-full min-h-0",
    initialFocus: "none",
  });
};
