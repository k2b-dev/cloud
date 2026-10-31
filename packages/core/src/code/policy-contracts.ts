import { CAPABILITY_ASK_REASONS, type CapabilityActionPolicy } from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeIdSchema, CodeOwnerSchema } from "./contracts";

/** Classification rows shared by the checker, activation, dispatcher and administration. */
export const CODE_POLICY_ROWS = [
  "read",
  "silent_you",
  "silent_draft",
  "silent_shared",
  "ask_sends",
  "ask_deletes",
  "ask_cannot_undo",
  "ask_involves_people",
  "ask_changes_access",
  "ask_keeps_working",
  "ask_sensitive",
  "ask_app_asks",
  "ai",
  "internet",
] as const;
export const CodePolicyRowSchema = z.enum(CODE_POLICY_ROWS);
export type CodePolicyRow = z.infer<typeof CodePolicyRowSchema>;
/** Transport values for Automatisch / Admin gibt frei / Nie. */
export const CodePolicyValueSchema = z.enum(["automatic", "admin", "never"]);
export type CodePolicyValue = z.infer<typeof CodePolicyValueSchema>;
export const CodePolicyRuleSchema = z
  .object({
    groupId: z.uuid().nullable().describe("Group UUID, or null for the installation default."),
    row: CodePolicyRowSchema.describe("Call classification, independent of the application."),
    value: CodePolicyValueSchema.describe("Automatic, Cloud-admin approval, or forbidden."),
  })
  .strict();
export type CodePolicyRule = z.infer<typeof CodePolicyRuleSchema>;
export const CodePolicyPresetSchema = z.enum(["off", "admin", "open", "custom"]);
export type CodePolicyPreset = z.infer<typeof CodePolicyPresetSchema>;
export type CodePolicyDefinition = { preset: CodePolicyPreset; rules: CodePolicyRule[] };
/** Stored table shape. Historical presets remain readable; absent defaults resolve to never. */
export const StoredCodePolicyDefinitionSchema = z
  .object({
    preset: CodePolicyPresetSchema.describe("Off, admin, open, or a customized table."),
    // Fits within the 32 KiB capability input budget even with UUID group identities.
    rules: z.array(CodePolicyRuleSchema).max(200).describe("Complete default and group rules; missing group rules inherit."),
  })
  .strict();
/** Complete replacement: validate current presets and require one default per row. */
export const CodePolicyDefinitionSchema = StoredCodePolicyDefinitionSchema.superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const rule of value.rules) {
    const key = `${rule.groupId ?? "default"}:${rule.row}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate policy rule" });
    seen.add(key);
  }
  for (const row of CODE_POLICY_ROWS) if (!seen.has(`default:${row}`)) ctx.addIssue({ code: "custom", message: `Missing default: ${row}` });
  if (
    value.preset !== "custom" &&
    JSON.stringify([...value.rules].sort(ruleOrder)) !== JSON.stringify(codePolicyPreset(value.preset).rules.sort(ruleOrder))
  )
    ctx.addIssue({ code: "custom", message: "Preset does not match its rules; use custom for edits" });
});
const ruleOrder = (a: CodePolicyRule, b: CodePolicyRule) => `${a.groupId ?? ""}:${a.row}`.localeCompare(`${b.groupId ?? ""}:${b.row}`);
export const CodePolicySchema = z
  .object({
    revision: z.number().int().positive(),
    definition: StoredCodePolicyDefinitionSchema,
    updatedBy: z.uuid().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type CodePolicy = z.infer<typeof CodePolicySchema>;
/** Presets replace the complete table, including group overrides. Sending remains gated by submission in Phase 1. */
export function codePolicyPreset(preset: Exclude<CodePolicyPreset, "custom">): CodePolicyDefinition {
  return {
    preset,
    rules: CODE_POLICY_ROWS.map((row) => ({
      groupId: null,
      row,
      value: preset === "off" ? "never" : preset === "open" || ["read", "silent_you", "silent_draft"].includes(row) ? "automatic" : "admin",
    })),
  };
}
/** Conservative classification: an Action without declared policy requires the app_asks row. */
export function codePolicyRow(kind: "query" | "action" | "ai" | "internet", policy?: CapabilityActionPolicy): CodePolicyRow {
  if (kind === "query") return "read";
  if (kind !== "action") return kind;
  if (!policy) return "ask_app_asks";
  if ("silent" in policy) return `silent_${policy.silent}`;
  const reason = CAPABILITY_ASK_REASONS.find((reason) => reason === policy.ask);
  return reason ? CodePolicyRowSchema.parse(`ask_${reason}`) : "ask_app_asks";
}
/** Required checked-manifest field. Missing/invalid classifications fail closed in the pause sweep. */
export const CodePolicyManifestSchema = z.object({
  policyRows: z
    .array(CodePolicyRowSchema)
    .max(CODE_POLICY_ROWS.length)
    .refine((rows) => new Set(rows).size === rows.length, "Policy classifications must be unique"),
});
export type CodePolicyManifest = z.infer<typeof CodePolicyManifestSchema>;
const revision = z.number().int().positive().describe("Revision from policy.read; stale drafts are rejected.");
const pageInput = {
  cursor: CodeIdSchema.optional().describe("Last affected Code ID from nextCursor."),
  limit: z.number().int().min(1).max(50).default(20).describe("Maximum affected Codes returned in this page."),
};
export const CodePolicyImpactSchema = z
  .object({
    codeId: CodeIdSchema,
    title: z.string(),
    rows: z.array(CodePolicyRowSchema),
    reason: z.enum(["policy_changed", "policy_rows_unavailable"]),
  })
  .strict();
/** Public policy Query and Action transport schemas, consumed by CLI and administration. */
export const codePolicyContracts = {
  read: { input: z.object({}).strict(), data: z.object({ policy: CodePolicySchema }).strict() },
  effective: {
    input: z
      .object({
        owner: CodeOwnerSchema.optional().describe("Defaults to the current person's Code. Other owners require Code administration."),
        authorId: z.uuid().optional().describe("Resource/app version author for veto rules; administrators only."),
      })
      .strict(),
    data: z
      .object({
        revision,
        rows: z.array(
          z
            .object({
              row: CodePolicyRowSchema,
              value: CodePolicyValueSchema,
              source: z.enum(["default", "group", "veto"]),
              groupIds: z.array(z.uuid()),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  preview: {
    input: z
      .object({
        revision,
        definition: CodePolicyDefinitionSchema.describe("Complete replacement table, including defaults and group overrides."),
        ...pageInput,
      })
      .strict(),
    data: z
      .object({
        revision,
        total: z.number().int().nonnegative(),
        items: z.array(CodePolicyImpactSchema),
        nextCursor: CodeIdSchema.nullable(),
      })
      .strict(),
  },
  update: {
    input: z
      .object({
        revision,
        definition: CodePolicyDefinitionSchema.describe("Complete replacement table, including defaults and group overrides."),
      })
      .strict(),
    data: z.object({ policy: CodePolicySchema, pauseJobId: z.uuid() }).strict(),
  },
} as const;
