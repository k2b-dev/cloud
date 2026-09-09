import {
  arg,
  type CliInputFlagValue,
  type CloudCliContext,
  cliText,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  printRows,
  printStructured,
  readCliInput,
} from "@k2b/cloud/cli";
import type { MessageResponse } from "@k2b/cloud/contracts";
import { type CreateFaq, type FaqAudience, FaqAudienceSchema, type FaqEntry, FaqTranslationsSchema, type UpdateFaq } from "./contracts";

const apiPath = (path = "") => `/api/faq${path === "/" ? "" : path}`;

const apiGet = async <T>(ctx: CloudCliContext, path = ""): Promise<T> => ctx.readJson<T>(await ctx.fetch(apiPath(path)));

const apiJson = async <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(apiPath(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const translationsFlag = (required: boolean) =>
  flag.input({
    description: "Translations JSON object; pass a value, --translations-file, or --stdin",
    valueLabel: "json",
    required,
  });

const readTranslations = async (input: CliInputFlagValue, required: boolean) => {
  const raw = await readCliInput(input, { label: "FAQ translations JSON", required, trimFinalNewline: true });
  if (raw === undefined) return undefined;
  return FaqTranslationsSchema.parse(JSON.parse(raw) as unknown);
};

const parseAudience = (values: string[], required: boolean): FaqAudience[] | undefined => {
  if (values.length === 0) {
    if (required) throw new Error("Missing audience. Pass --audience anonymous,guest,user.");
    return undefined;
  }
  return values.map((value) => FaqAudienceSchema.parse(value));
};

const listEntries = async (ctx: CloudCliContext): Promise<FaqEntry[]> => (await apiGet<{ entries: FaqEntry[] }>(ctx, "/")).entries;

const entryRows = (entries: FaqEntry[]) =>
  entries.map((entry) => ({
    position: entry.position,
    question: entry.translations.en?.question ?? "",
    locales: Object.keys(entry.translations).join(","),
    audience: entry.audience.join(","),
    id: entry.id,
  }));

const printEntryMutation = (ctx: CloudCliContext, entry: FaqEntry, action: "created" | "updated") => {
  if (printStructured(ctx, entry)) return;
  ctx.print(
    cliText(ctx, {
      en: `${action === "created" ? "Created" : "Updated"} FAQ entry ${entry.id}.`,
      de: `FAQ-Eintrag ${entry.id} ${action === "created" ? "erstellt" : "aktualisiert"}.`,
    }),
  );
};

const printMessage = (ctx: CloudCliContext, result: MessageResponse) => {
  if (!printStructured(ctx, result)) ctx.print(result.message);
};

export default defineCliCommands({
  name: "faq",
  summary: "Manage FAQ entries.",
  commands: [
    command("list", {
      summary: "List FAQ entries",
      async run({ ctx }) {
        const entries = await listEntries(ctx);
        printRows(ctx, entries, entryRows(entries), [
          { key: "position" },
          { key: "question" },
          { key: "locales" },
          { key: "audience" },
          { key: "id" },
        ]);
      },
    }),
    command("get", {
      summary: "Show one FAQ entry",
      args: { id: arg.required({ valueLabel: "id", description: "FAQ entry UUID" }) },
      async run({ ctx, args }) {
        const entry = (await listEntries(ctx)).find((item) => item.id === args.id);
        if (!entry) throw new Error(`FAQ entry "${args.id}" was not found.`);
        if (!printStructured(ctx, entry)) ctx.print(JSON.stringify(entry, null, 2));
      },
    }),
    command("create", {
      summary: "Create an FAQ entry",
      flags: {
        translations: translationsFlag(true),
        audience: flag.stringList({ description: "Audience: anonymous, guest, or user. Repeat or comma-separate." }),
      },
      examples: [
        "cld faq create --translations-file ./translations.json --audience anonymous,guest",
        "cat translations.json | cld faq create --stdin --audience user --json",
      ],
      async run({ ctx, flags }) {
        const data: CreateFaq = {
          translations: (await readTranslations(flags.translations, true))!,
          audience: parseAudience(flags.audience, true)!,
        };
        const entry = await apiJson<FaqEntry>(ctx, "POST", "/", data);
        printEntryMutation(ctx, entry, "created");
      },
    }),
    command("update", {
      summary: "Update an FAQ entry",
      args: { id: arg.required({ valueLabel: "id", description: "FAQ entry UUID" }) },
      flags: {
        translations: translationsFlag(false),
        audience: flag.stringList({ description: "Replacement audience. Repeat or comma-separate." }),
      },
      async run({ ctx, args, flags }) {
        const data: UpdateFaq = {
          translations: await readTranslations(flags.translations, false),
          audience: parseAudience(flags.audience, false),
        };
        if (data.translations === undefined && data.audience === undefined) {
          throw new Error("Pass --translations, --translations-file, --stdin, or --audience.");
        }
        const entry = await apiJson<FaqEntry>(ctx, "PATCH", `/${encodeURIComponent(args.id)}`, data);
        printEntryMutation(ctx, entry, "updated");
      },
    }),
    command("delete", {
      summary: "Delete an FAQ entry",
      args: { id: arg.required({ valueLabel: "id", description: "FAQ entry UUID" }) },
      flags: { yes: confirmFlag("Delete the FAQ entry") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/${encodeURIComponent(args.id)}`);
        printMessage(ctx, result);
      },
    }),
    command("reorder", {
      summary: "Replace the complete FAQ entry order",
      description: "Pass every FAQ entry UUID once, in the desired order.",
      args: { ids: arg.rest({ valueLabel: "id", required: true }) },
      async run({ ctx, args }) {
        const result = await apiJson<MessageResponse>(ctx, "PUT", "/reorder", { ids: args.ids });
        printMessage(ctx, result);
      },
    }),
  ],
});
