import { type KeyboardPlatform, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { onContextChange } from "../browser/panel";
import { onPanelShortcutsChange } from "../browser/panel-shortcuts";
import { readHelpPanelShortcuts } from "./layout-help-panel-shortcuts";
import { type HelpShortcutCommand, helpShortcutGroups } from "./layout-help-start";
import { HelpShortcutsView } from "./layout-help-views";
import { platformMessages } from "./platform-messages";
import { shellShortcuts } from "./shell-shortcuts";

export default function HelpPanelShortcuts(props: { appName?: string; platform: KeyboardPlatform }) {
  const locale = useLocale();
  const seed = shellShortcuts(platformMessages.resolve([locale()]).t, { panel: true });
  const [commands, setCommands] = createSignal<HelpShortcutCommand[]>(seed);
  onMount(() => {
    const update = () => setCommands(readHelpPanelShortcuts(seed));
    onCleanup(onPanelShortcutsChange(update));
    onCleanup(onContextChange(update));
    update();
  });
  return <HelpShortcutsView groups={helpShortcutGroups(commands())} appName={props.appName} platform={props.platform} />;
}
