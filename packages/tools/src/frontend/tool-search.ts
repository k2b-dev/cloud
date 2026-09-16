import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const toolSearchMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tools: "Tools",
      searchTools: "Search tools",
      searchToolsLabel: "Search Tools",
      searchToolsWithShortcut: ({ shortcut }: { shortcut: string }) => `Search tools (${shortcut})`,
    },
    de: {
      tools: "Werkzeuge",
      searchTools: "Werkzeuge suchen",
      searchToolsLabel: "Werkzeuge suchen",
      searchToolsWithShortcut: ({ shortcut }) => `Werkzeuge suchen (${shortcut})`,
    },
  },
});

export function createToolSearch() {
  const locale = useLocale();
  return () => openGlobalSearch({ scope: { appId: "tools", label: toolSearchMessages.resolve([locale()]).t.tools, icon: "ti ti-tools" } });
}
