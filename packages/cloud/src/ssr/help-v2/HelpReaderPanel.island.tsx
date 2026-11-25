import { useLocale } from "@k2b/ui";
import { getContext, onContextChange } from "../../browser/panel";
import { onPanelShortcutsChange } from "../../browser/panel-shortcuts";
import { readHelpPanelShortcuts } from "../layout-help-panel-shortcuts";
import { platformMessages } from "../platform-messages";
import { shellShortcuts } from "../shell-shortcuts";
import { HelpReader, type HelpReaderProps } from "./HelpReader";

/**
 * The v2 Help reader in the side panel: the shortcuts and "For this view" follow the page beside the panel, as the
 * host sends them; the open article is in the panel's own address (`?topic=`).
 */
export default function HelpReaderPanel(props: Omit<HelpReaderProps, "surface" | "shortcuts" | "viewSource">) {
  const locale = useLocale();
  const seed = shellShortcuts(platformMessages.resolve([locale()]).t, { panel: true });
  const viewIds = (context: ReturnType<typeof getContext>) => (context && context.app === props.app?.id ? (context.help ?? []) : []);
  return (
    <HelpReader
      {...props}
      surface="panel"
      shortcuts={{
        seed,
        read: () => readHelpPanelShortcuts(seed),
        subscribe: (update) => {
          const stopShortcuts = onPanelShortcutsChange(update);
          const stopContext = onContextChange(update);
          return () => {
            stopShortcuts();
            stopContext();
          };
        },
      }}
      viewSource={{
        subscribe: (update) => {
          const context = getContext();
          if (context) update(viewIds(context));
          return onContextChange((next) => update(viewIds(next)));
        },
      }}
    />
  );
}
