import type { AiSkillAdminListItem } from "../../ai/skills";
import { arg, command, confirmFlag, flag, printRows, printStructured } from "../index";
import { apiGet, apiJson, queryString } from "./shared";

export const aiSkillCommands = [
  command("ai skills list", {
    summary: "List all Skills with source app, availability, status, and revision (platform admin)",
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
      printRows(
        ctx,
        result,
        result.items.map((skill) => ({
          ...skill,
          app: skill.source?.appName ?? "",
          status: skill.source?.status ?? "",
          available: skill.source?.available ?? "",
          appVersion: skill.source?.appVersion ?? "",
        })),
        [
          { key: "shortId" },
          { key: "name" },
          { key: "revision" },
          { key: "app" },
          { key: "status" },
          { key: "available" },
          { key: "appVersion" },
        ],
      );
    },
  }),
  command("ai skills reset", {
    summary: "Replace Skill content and references with the owning app's current version",
    args: { skillId: arg.required() },
    flags: {
      expectedRevision: flag.int({ name: "revision", required: true, min: 1 }),
      expectedAppVersion: flag.string({ name: "app-version", required: true }),
      yes: confirmFlag("Confirm resetting this Skill; export customized content first"),
    },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Review the Skill first, then confirm with --yes.");
      const result = await apiJson(ctx, "POST", `/api/admin/core/ai-skills/${encodeURIComponent(args.skillId)}/reset`, {
        expectedRevision: flags.expectedRevision,
        expectedAppVersion: flags.expectedAppVersion,
        confirmed: true,
      });
      if (!printStructured(ctx, result)) ctx.print("Skill reset to the app version.");
    },
  }),
  ...(
    [
      ["restore", "Install a deleted app Skill again from the app's version, when its name is free", "App Skill installed."],
      [
        "adopt",
        "Link the existing Skill that holds an app Skill's name to that app, keeping its content",
        "Existing Skill linked to the app.",
      ],
    ] as const
  ).map(([action, summary, done]) =>
    command(`ai skills ${action}`, {
      summary,
      args: { appId: arg.required(), name: arg.required() },
      flags: { yes: confirmFlag(`Confirm the app and Skill name to ${action}`) },
      run: async ({ ctx, args, flags }) => {
        if (!flags.yes) throw new Error("Review the app Skill first, then confirm with --yes.");
        const result = await apiJson(
          ctx,
          "POST",
          `/api/admin/core/ai-skills/apps/${encodeURIComponent(args.appId)}/skills/${encodeURIComponent(args.name)}/${action}`,
          { confirmed: true },
        );
        if (!printStructured(ctx, result)) ctx.print(done);
      },
    }),
  ),
];
