import { arg, type CloudCliContext, cliText, command, confirmFlag, flag, printRows, printStructured, readCliInput } from "../index";
import { apiGet } from "./shared";

const LEGAL_KINDS = ["terms", "privacy", "imprint"] as const;
type LegalKind = (typeof LEGAL_KINDS)[number];
type LegalMode = "local" | "external";

type LegalDocument = {
  kind: LegalKind;
  path: string;
  mode: LegalMode;
  content: string;
  url: string;
};

const legalApiPath = "/api/admin/core/settings";

const parseKind = (value: string): LegalKind => {
  if (LEGAL_KINDS.includes(value as LegalKind)) return value as LegalKind;
  throw new Error(`Document must be one of: ${LEGAL_KINDS.join(", ")}.`);
};

const listDocuments = async (ctx: CloudCliContext): Promise<LegalDocument[]> =>
  (await apiGet<{ items: LegalDocument[] }>(ctx, `${legalApiPath}/legal`)).items;

const getDocument = async (ctx: CloudCliContext, kind: LegalKind): Promise<LegalDocument> => {
  const document = (await listDocuments(ctx)).find((item) => item.kind === kind);
  if (!document) throw new Error(`Legal document "${kind}" was not found.`);
  return document;
};

const saveSettings = async (ctx: CloudCliContext, body: { updates?: Record<string, unknown>; resets?: string[] }): Promise<void> => {
  const response = await ctx.fetch(legalApiPath, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  await ctx.readJson(response);
  throw new Error(`Settings request failed with ${response.status}.`);
};

const printDocument = (ctx: CloudCliContext, document: LegalDocument) => {
  if (printStructured(ctx, document)) return;
  ctx.print(
    [
      `${document.kind} (${document.mode})`,
      `Path: ${document.path}`,
      ...(document.mode === "external" ? [`URL: ${document.url || "-"}`] : ["", document.content || "No local content configured."]),
    ].join("\n"),
  );
};

export const legalCommands = [
  command("legal list", {
    summary: "List Terms, Privacy, and Imprint configuration",
    run: async ({ ctx }) => {
      const items = await listDocuments(ctx);
      printRows(
        ctx,
        items,
        items.map((document) => ({
          document: document.kind,
          source: document.mode,
          target: document.mode === "external" ? document.url : document.path,
        })),
        [{ key: "document" }, { key: "source" }, { key: "target" }],
      );
    },
  }),
  command("legal get", {
    summary: "Show one legal document configuration",
    args: { document: arg.required({ valueLabel: "terms|privacy|imprint" }) },
    run: async ({ ctx, args }) => printDocument(ctx, await getDocument(ctx, parseKind(args.document))),
  }),
  command("legal set", {
    summary: "Publish local Markdown or redirect to an external URL",
    args: { document: arg.required({ valueLabel: "terms|privacy|imprint" }) },
    flags: {
      content: flag.input({ description: "Local Markdown; pass a value, --content-file, or --stdin" }),
      url: flag.string({ description: "External URL" }),
    },
    examples: ["cld admin legal set terms --content-file ./terms.md", "cld admin legal set privacy --url https://example.org/privacy"],
    run: async ({ ctx, args, flags }) => {
      const kind = parseKind(args.document);
      const contentProvided = flags.content.provided;
      const urlProvided = flags.url !== undefined;
      if (contentProvided === urlProvided) throw new Error("Pass exactly one of --content, --content-file, --stdin, or --url.");

      const mode: LegalMode = contentProvided ? "local" : "external";
      const value = contentProvided ? await readCliInput(flags.content, { label: `${kind} Markdown`, required: true }) : flags.url?.trim();
      if (mode === "external" && !value) throw new Error("--url must not be empty.");

      await saveSettings(ctx, {
        updates: {
          [`legal.${kind}.mode`]: mode,
          [`legal.${kind}.${mode === "local" ? "content" : "url"}`]: value ?? "",
        },
      });
      const result = { document: kind, mode };
      if (!printStructured(ctx, result)) {
        ctx.print(cliText(ctx, { en: `Updated ${kind}.`, de: `${kind} wurde aktualisiert.` }));
      }
    },
  }),
  command("legal reset", {
    summary: "Reset one legal document to its defaults",
    args: { document: arg.required({ valueLabel: "terms|privacy|imprint" }) },
    flags: { yes: confirmFlag("Reset the legal document") },
    run: async ({ ctx, args, flags }) => {
      const kind = parseKind(args.document);
      if (!flags.yes) throw new Error("Refusing to reset without --yes.");
      await saveSettings(ctx, {
        resets: [`legal.${kind}.mode`, `legal.${kind}.content`, `legal.${kind}.url`],
      });
      const result = { document: kind, reset: true };
      if (!printStructured(ctx, result)) {
        ctx.print(cliText(ctx, { en: `Reset ${kind}.`, de: `${kind} wurde zurückgesetzt.` }));
      }
    },
  }),
];
