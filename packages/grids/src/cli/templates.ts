import { arg, type CloudCliContext, command, flag } from "@k2b/cloud/cli";
import type { PublicBase as Base } from "../api/public-dto";
import { GRIDS_BASE_DEFAULT_KEY } from "./resources";
import { exactMatch, jsonRequest, printJsonOrMessage, printJsonOrTable, readApi } from "./runtime";

type BuiltInBaseTemplate = {
  id: string;
  name: string;
  description: string;
  highlights: [string, string, string];
  icon: string;
};

const listTemplates = (ctx: CloudCliContext): Promise<BuiltInBaseTemplate[]> => readApi<BuiltInBaseTemplate[]>(ctx, "/templates");

const resolveTemplate = async (ctx: CloudCliContext, ref: string): Promise<BuiltInBaseTemplate> =>
  exactMatch(
    await listTemplates(ctx),
    ref,
    [(template) => template.id, (template) => template.name],
    "built-in base template",
    (template) => `${template.name} (${template.id})`,
  );

export const baseTemplateCommands = [
  command("templates list", {
    summary: "List built-in Grids base templates",
    async run({ ctx }) {
      const templates = await listTemplates(ctx);
      printJsonOrTable(
        ctx,
        templates,
        templates.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          highlights: template.highlights.join("; "),
        })),
        [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "description", label: "DESCRIPTION" },
          { key: "highlights", label: "HIGHLIGHTS" },
        ],
      );
    },
  }),
  command("templates instantiate", {
    summary: "Create a base from a built-in template",
    description: "Sample records are included by default. Pass --empty to create the complete template without sample records.",
    args: { template: arg.required({ description: "Template id or exact name" }) },
    flags: {
      name: flag.string({ description: "Name for the new base" }),
      empty: flag.boolean({ description: "Create the template without sample records" }),
      use: flag.boolean({ description: "Use the new base as the default Grids base" }),
    },
    examples: [
      "cld grids templates instantiate inventory --use --json",
      'cld grids templates instantiate "Bookshop" --name "Library operations" --empty --json',
    ],
    async run({ ctx, args, flags }) {
      const template = await resolveTemplate(ctx, args.template);
      const base = await readApi<Base>(
        ctx,
        `/templates/${encodeURIComponent(template.id)}`,
        jsonRequest("POST", { name: flags.name, withSampleData: flags.empty ? false : undefined }),
      );
      if (flags.use) await ctx.setDefault(GRIDS_BASE_DEFAULT_KEY, base.id);
      printJsonOrMessage(ctx, base, `Created ${base.name} (${base.id}) from ${template.name}.${flags.use ? " Using it as default." : ""}`);
    },
  }),
];
