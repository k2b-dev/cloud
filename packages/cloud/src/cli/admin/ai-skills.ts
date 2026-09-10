import type { AiSkillAdminListItem } from "../../ai/skills";
import { arg, command, confirmFlag, flag, printRows, printStructured } from "../index";
import { apiGet, apiJson, queryString } from "./shared";

export const aiSkillCommands = [
  command("ai skills list", {
    summary: "List all Skills with template origin, version, status, and revision (platform admin)",
    flags: {
      search: flag.string(),
      page: flag.int({ min: 1, default: 1 }),
      perPage: flag.int({ name: "per-page", min: 1, max: 500, default: 100 }),
    },
    run: async ({ ctx, flags }) => {
      const result = await apiGet<{ items: AiSkillAdminListItem[]; total: number; page: number; perPage: number }>(
        ctx,
        `/api/admin/core/ai-skills${queryString(flags)}`,
      );
      printRows(ctx, result, result.items, [
        { key: "shortId" },
        { key: "name" },
        { key: "revision" },
        { key: "templateId" },
        { key: "templateVersion" },
        { key: "currentTemplateVersion" },
        { key: "templateStatus" },
      ]);
    },
  }),
  command("ai skills templates", {
    summary: "List current trusted Skill template IDs and versions",
    run: async ({ ctx }) => {
      const result = await apiGet<{ templates: { templateId: string; name: string; version: number }[] }>(
        ctx,
        "/api/admin/core/ai-skills/templates",
      );
      printRows(ctx, result, result.templates, [{ key: "templateId" }, { key: "name" }, { key: "version" }]);
    },
  }),
  ...(["associate", "reset"] as const).map((mode) =>
    command(`ai skills ${mode}`, {
      summary:
        mode === "associate"
          ? "Associate an existing Skill with a template, preserving all content"
          : "Replace all linked Skill content and references with the current template",
      args: { skillId: arg.required() },
      flags: {
        templateId: flag.string({ name: "template", required: true }),
        templateVersion: flag.int({ name: "template-version", required: true, min: 1 }),
        expectedRevision: flag.int({ name: "revision", required: true, min: 1 }),
        yes: confirmFlag("Confirm the exact Skill and template; export customized content before resetting"),
      },
      run: async ({ ctx, args, flags }) => {
        if (!flags.yes) throw new Error("Review the Skill and template first, then confirm with --yes.");
        const { yes: _yes, ...input } = flags;
        const result = await apiJson(ctx, "POST", `/api/admin/core/ai-skills/${encodeURIComponent(args.skillId)}/template`, {
          ...input,
          mode,
          confirmed: true,
        });
        if (!printStructured(ctx, result)) ctx.print("Skill template updated.");
      },
    }),
  ),
];
