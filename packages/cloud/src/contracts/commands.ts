import { z } from "zod";

/** Commands carry small public references/options, never document bodies or secrets. */
export const COMMAND_MAX_URL_LENGTH = 8192;
export const CommandPathSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    if (!value.startsWith("/") || /[\\\u0000-\u0020]/u.test(value)) return false;
    try {
      return new URL(value, "https://cloud.invalid").origin === "https://cloud.invalid";
    } catch {
      return false;
    }
  }, "Expected a Cloud path");

export const CommandOptionsSchema = z.object({ returnTo: CommandPathSchema.optional() }).strict();
export type CommandOptions = z.infer<typeof CommandOptionsSchema>;
export const CommandRequestSchema = CommandOptionsSchema.extend({ input: z.unknown() }).strict();
export const CommandLinkSchema = z.object({ href: z.url().max(COMMAND_MAX_URL_LENGTH) }).strict();

export const commandPath = (path: string, command: string, input: unknown, options: CommandOptions = {}): string => {
  const url = new URL(CommandPathSchema.parse(path), "https://cloud.invalid");
  url.searchParams.set("command", command);
  url.searchParams.set("commandInput", JSON.stringify(input));
  const parsed = CommandOptionsSchema.parse(options);
  if (parsed.returnTo) url.searchParams.set("commandReturn", parsed.returnTo);
  else url.searchParams.delete("commandReturn");
  const result = `${url.pathname}${url.search}${url.hash}`;
  if (result.length > COMMAND_MAX_URL_LENGTH) throw new Error("Command link is too large");
  return result;
};

export const readCommand = (url: URL) => {
  const id = url.searchParams.get("command");
  if (!id) return null;
  const raw = url.searchParams.get("commandInput") ?? "{}";
  if (url.href.length > COMMAND_MAX_URL_LENGTH) throw new Error("Command link is too large");
  return {
    id,
    input: JSON.parse(raw) as unknown,
    options: CommandOptionsSchema.parse({ returnTo: url.searchParams.get("commandReturn") ?? undefined }),
  };
};

export const clearCommand = (url: URL): string => {
  for (const key of ["command", "commandInput", "commandReturn"]) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
};
