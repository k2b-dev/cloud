import { useLocale } from "@k2b/ui";
import { COMMANDS_CHANGED, contextCommandsWithShortcuts } from "../../browser/command-shortcuts";
import type { LayoutHelpPageProps } from "../LayoutHelp";
import type { HelpShortcutCommand } from "../layout-help-start";
import { platformMessages } from "../platform-messages";
import { useShellData } from "../shell-data";
import { shellShortcuts } from "../shell-shortcuts";
import { HelpReader } from "./HelpReader";

/**
 * The app's full-page Help on v2 (`@k2b/cloud/ssr/help-v2/HelpPage`), for a page whose layout has `ui: "v2"`: the
 * articles as a list and the open one beside it, its address the app's Help route. The same documents and first article
 * as `LayoutHelpPage`, with the page's shortcuts. A separate entry, so the shell does not load v2.
 */
export default function LayoutHelpPageV2(props: Omit<LayoutHelpPageProps, "embedded" | "accent">) {
  const locale = useLocale();
  const shell = useShellData();
  const app = shell?.apps.find((candidate) => candidate.id === shell.appId);
  const seed: HelpShortcutCommand[] = shell ? shellShortcuts(platformMessages.resolve([locale()]).t, { panel: !!shell.panel }) : [];
  const read = (): HelpShortcutCommand[] => {
    const commands = contextCommandsWithShortcuts();
    return [...seed.filter((command) => !commands.some((other) => other.id === command.id)), ...commands];
  };
  return (
    <HelpReader
      surface="page"
      documents={props.documents}
      app={shell?.appId && app ? { id: shell.appId, name: app.label, icon: app.iconClass } : undefined}
      initialTopic={props.initialTopic}
      initialArticle={props.initialArticle}
      pageBase={props.pageBase}
      platform={shell?.platform}
      state={shell?.helpFailed ? "failed" : undefined}
      shortcuts={
        props.includeShortcuts === false
          ? undefined
          : {
              seed,
              read,
              subscribe: (update) => {
                window.addEventListener(COMMANDS_CHANGED, update);
                return () => window.removeEventListener(COMMANDS_CHANGED, update);
              },
            }
      }
    />
  );
}
