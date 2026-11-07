import { prompts } from "@k2b/ui";

/** Asks for a chat's new name; loaded when someone renames, so the part's first load does not carry the dialog. */
export const askChatName = (label: string, current: string, title: string): Promise<string | null | undefined> =>
  prompts.prompt(label, current, { title });
