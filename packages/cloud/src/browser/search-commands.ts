import { z } from "zod";
import type { SearchItem } from "../api/search/schemas";
import { listCapabilityCatalog } from "../capabilities/client";
import { LOCALE_HEADER } from "../shared/locale";
import type { ContextAwareCommand } from "./command-bridge";

export type PaletteCommand = ContextAwareCommand & { appName?: string; keywords?: readonly string[]; context?: boolean };
export const loadSearchCommands = async (locale: string, signal: AbortSignal): Promise<PaletteCommand[]> => {
  const commands: PaletteCommand[] = [];
  let cursor: string | undefined;
  do {
    const result = await listCapabilityCatalog({ limit: 25, cursor, signal, headers: { [LOCALE_HEADER]: locale } });
    if (!result.ok) throw new Error(result.error.message);
    for (const app of result.data.apps) {
      for (const command of app.manifest.commands) {
        // Only Commands with a valid empty invocation are globally discoverable.
        const input = z.fromJSONSchema(structuredClone(command.inputSchema)).safeParse({});
        if (!input.success) continue;
        const id = `${app.appId}.${command.localId}`;
        commands.push({
          id,
          title: command.title,
          description: command.description,
          icon: command.icon ?? app.appIcon,
          keywords: command.keywords,
          appName: app.appName,
          action: { command: id, input: input.data },
        });
      }
    }
    const next = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
    if (next && cursor && next <= cursor) throw new Error("Invalid Command catalog cursor");
    cursor = next;
  } while (cursor);
  return commands;
};
export const commandSearchItem = (command: PaletteCommand, group: string): SearchItem => ({
  ref: { type: "cloud.command", id: command.id },
  href: "",
  readable: false,
  appId: command.context ? "cloud.context" : "cloud.commands",
  appName: group,
  appIcon: "ti ti-command",
  title: command.title,
  icon: command.icon ?? "ti ti-command",
  preview: command.description,
});
export const matchingCommands = (commands: readonly PaletteCommand[], query: string, all: boolean): PaletteCommand[] => {
  const normalized = query.toLocaleLowerCase().trim();
  const matches = commands.filter((command) =>
    !normalized
      ? all || (command.context && !command.id.startsWith("cloud."))
      : [command.title, command.description, command.appName, ...(command.keywords ?? [])]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized),
  );
  return !normalized && !all ? matches.slice(0, 3) : matches;
};
