import { z } from "zod";
import { CapabilityQualifiedIdSchema, CloudResourceRefSchema } from "./capabilities";
import { CodeInternetOriginsSchema } from "./code-internet";
import { CodeRouteSchema } from "./code-routes";
import { CodeSecretVersionBindingSchema } from "./code-secrets";

/** Automation display title: the Code title's 200-character budget, one line of escaped plain text. */
export const CodeAutomationTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);

/** An absolute one-time instant; omitted display zone inherits the Cloud instance setting. */
export const CodeOnceScheduleSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }).describe("One-time absolute date-time with Z or a numeric UTC offset."),
  timeZone: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Use a valid IANA time zone")
    .optional()
    .describe("IANA time zone for displaying the scheduled instant; defaults to the Cloud instance time zone."),
});
/** Exact checked resource event registration. It carries no resource grants. */
export const CodeEventTriggerSchema = z
  .object({
    type: CapabilityQualifiedIdSchema.describe("Qualified event type from the capability catalog."),
    version: z.number().int().positive().describe("Exact declared event version."),
    place: CloudResourceRefSchema.describe("Exact readable place whose events this registration accepts."),
  })
  .strict();

export const CodeVersionEntrypointSchema = z
  .strictObject({
    kind: z.enum(["schedule", "manual", "event", "route"]).describe("Scheduled, manually invoked, event-triggered or HTTP entrypoint."),
    event: CodeEventTriggerSchema.optional().describe("Exact event version and place for an event entrypoint."),
    route: CodeRouteSchema.optional().describe("Checked method, path and public declaration for a route handler."),
    entrypoint: z.string().min(1).describe("Named ESM export selected by the runner."),
    title: CodeAutomationTitleSchema.optional().describe("Optional reviewed display title; entrypoint remains the stable key."),
    cron: z.string().nullable().describe("Five-field cron expression; null for a one-time or manual entrypoint."),
    at: CodeOnceScheduleSchema.shape.at.optional().describe("One-time absolute date-time with Z or a numeric UTC offset."),
    timeZone: CodeOnceScheduleSchema.shape.timeZone
      .optional()
      .describe("IANA schedule time zone; defaults to the Cloud instance time zone."),
    file: z.string().min(1).describe("Relative source file containing this declaration or operation."),
    line: z.number().int().positive().describe("One-based source line."),
  })
  .superRefine((entry, context) => {
    if (
      entry.kind === "event"
        ? !entry.event ||
          entry.cron !== null ||
          (entry.entrypoint !== `event:${entry.event.type}@${entry.event.version}` &&
            !(
              entry.entrypoint.startsWith(`event:${entry.event.type}@${entry.event.version}:place:`) &&
              /^(0|[1-9][0-9]*)$/.test(entry.entrypoint.slice(`event:${entry.event.type}@${entry.event.version}:place:`.length))
            ))
        : !!entry.event
    )
      context.addIssue({ code: "custom", message: "Event metadata and stable entrypoint must match the registration kind" });
    if ((entry.kind === "route") !== (entry.route !== undefined))
      context.addIssue({ code: "custom", message: "Routes require a route descriptor; other entrypoints forbid it" });
    if (entry.timeZone !== undefined && entry.kind !== "schedule")
      context.addIssue({ code: "custom", message: "Only schedules may carry a timeZone" });
    const once = entry.at !== undefined || (entry.timeZone !== undefined && !entry.cron);
    if (once && (entry.kind !== "schedule" || entry.cron !== null || !entry.at))
      context.addIssue({ code: "custom", message: "A one-time schedule needs at, with cron null" });
  });

const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 digest produced by the checker.");
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
  "public_routes",
] as const;
export const CodePolicyRowSchema = z.enum(CODE_POLICY_ROWS);
/** Stable call classification shared by checker, activation, dispatcher and administration. */
export type CodePolicyRow = z.infer<typeof CodePolicyRowSchema>;
/** Required checked-manifest field. Missing/invalid classifications fail closed in the pause sweep. */
export const CodePolicyManifestSchema = z.object({
  policyRows: z
    .array(CodePolicyRowSchema)
    .max(CODE_POLICY_ROWS.length)
    .refine((rows) => new Set(rows).size === rows.length, "Policy classifications must be unique")
    .describe("Unique policy classifications covering every declared operation and AI or internet use."),
});
/** Checked immutable version classifications; policyRows contains each used row once. */
export type CodePolicyManifest = z.infer<typeof CodePolicyManifestSchema>;
/** Checker permission, retaining separate source rows for targets and refs. Null id is a dynamic target. */
export const CodeVersionPermissionSchema = z
  .object({
    operation: z.string().min(1).describe("Fully qualified operation ID from the capability catalog."),
    target: z
      .object({
        type: z.string().min(1).describe("Fully qualified target resource Type."),
        id: z.string().min(1).nullable().describe("Literal target ID, or null for a dynamic target."),
      })
      .strict()
      .nullable()
      .describe("Exact operation target, or null for an app-wide operation."),
    file: z.string().min(1).describe("Relative source file containing this declaration or operation."),
    line: z.number().int().positive().describe("One-based source line."),
    entrypoints: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Sorted entrypoints whose handler contains this call; absent when the checker cannot place it."),
  })
  .strict();
/** One permission emitted by the checker, with its source location and, when known, the entrypoints that use it. */
export type CodeVersionPermission = z.infer<typeof CodeVersionPermissionSchema>;
/** The checker's immutable manifest plus the host's original check entry and policyRows.
 * Copy version/entrypoints/permissions/ai/hashes unchanged from checkCode's result.
 * entry comes from CodeCheckRequest.entry; policyRows comes from trusted operation metadata.
 * A manifest is evidence, never execution authority: dispatch checks each actual call.
 */
export const CodeCheckedVersionManifestSchema = CodePolicyManifestSchema.extend({
  version: z.literal(1).describe("Checker manifest format version, currently 1."),
  entry: z.string().min(1).describe("Original checker entry path, included in the source hash."),
  entrypoints: z.array(CodeVersionEntrypointSchema).describe("All named executable entrypoints detected by the checker."),
  permissions: z.array(CodeVersionPermissionSchema).describe("Every detected operation and target with its source location."),
  secrets: z
    .array(CodeSecretVersionBindingSchema)
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length, "Secret names must be unique")
    .optional()
    .describe("Exact secret bindings reviewed with this version; absent means no secret access."),
  internet: CodeInternetOriginsSchema.optional().describe("Every exact HTTPS origin declared by this version, with or without secrets."),
  ai: z.boolean().describe("Whether detected operations use AI."),
  hashes: z
    .object({ source: hash, sdk: hash, bundle: hash })
    .strict()
    .describe("Source, generated SDK and exact bundle digests from checking."),
})
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.entrypoints.some((entry) => entry.route?.public) && !manifest.policyRows.includes("public_routes"))
      ctx.addIssue({ code: "custom", message: "Public route classification missing from policyRows" });
    if (manifest.internet?.length && !manifest.policyRows.includes("internet"))
      ctx.addIssue({ code: "custom", message: "Internet classification missing from policyRows" });
    if (manifest.secrets?.length && !manifest.policyRows.includes("internet"))
      ctx.addIssue({ code: "custom", message: "Secret bindings require internet classification" });
    if (manifest.ai && !manifest.policyRows.includes("ai"))
      ctx.addIssue({ code: "custom", message: "AI classification missing from policyRows" });
  });
/** Checker evidence enriched by the trusted host for submission, activation, CLI and chat tools. */
export type CodeCheckedVersionManifest = z.infer<typeof CodeCheckedVersionManifestSchema>;
