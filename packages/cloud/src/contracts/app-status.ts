import { z } from "zod";
import { CapabilityAppIdSchema, type CapabilityManifest } from "./capabilities";
import { type CapabilityContractIssue, capabilityContractIssues } from "./capability-compatibility";

export const AppStatusWindowSchema = z.enum(["1h", "6h", "24h", "7d", "30d"]);
export type AppStatusWindow = z.infer<typeof AppStatusWindowSchema>;
export const AppStatusSummaryInputSchema = z
  .object({
    appIds: z.array(CapabilityAppIdSchema).min(1).max(200).describe("Application IDs whose status is requested."),
    window: AppStatusWindowSchema.describe("Traffic observation window."),
  })
  .strict();
export const AppStatusDetailInputSchema = z
  .object({
    appId: CapabilityAppIdSchema.describe("Application ID."),
    window: AppStatusWindowSchema.describe("Traffic observation window."),
    cursor: z.string().min(1).max(2048).optional().describe("Opaque continuation cursor from this provider."),
  })
  .strict();
export const AppStatusForgetInputSchema = z.object({ appId: CapabilityAppIdSchema.describe("Offline application ID to forget.") }).strict();
const count = z.number().int().nonnegative();
export const AppStatusTrafficSchema = z
  .object({
    requests: count,
    errors: count,
    avgMs: z.number().nonnegative().nullable(),
  })
  .strict();
export const AppStatusLinkSchema = z
  .object({
    label: z.string().min(1).max(120),
    href: z
      .string()
      .max(2048)
      .regex(/^\/admin\/[^\\\s\u0000-\u001f\u007f]*$/),
  })
  .strict();
export const AppStatusAppSchema = z
  .object({
    appId: CapabilityAppIdSchema.describe("Application ID."),
    traffic: AppStatusTrafficSchema.nullable(),
    links: z.array(AppStatusLinkSchema).max(4),
    lastSeenAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export const AppStatusSummaryDataSchema = z
  .object({
    // Requested apps plus the fifty provider-only apps; their rows carry lastSeenAt.
    apps: z.array(AppStatusAppSchema).max(250),
    otherApps: z.array(CapabilityAppIdSchema).max(50),
  })
  .strict();
export const AppStatusDetailDataSchema = z
  .object({
    routes: z.array(z.object({ prefix: z.string().min(1).max(2048), requests: count, errors: count }).strict()).max(200),
    failedRequests: z
      .array(
        z
          .object({
            at: z.string().datetime({ offset: true }),
            method: z.string().min(1).max(32),
            path: z.string().min(1).max(2048),
            status: z.number().int().min(100).max(599),
          })
          .strict(),
      )
      .max(50),
    totalFailedRequests: count.nullable().optional(),
    nextCursor: z.string().min(1).max(2048).nullable(),
  })
  .strict();
export const AppStatusForgetDataSchema = z.object({ forgotten: z.boolean() }).strict();
export type AppStatusSummaryData = z.infer<typeof AppStatusSummaryDataSchema>;
export type AppStatusDetailData = z.infer<typeof AppStatusDetailDataSchema>;

/** Shared role validation at startup, registry read, and consumer discovery. */
export const appStatusIssues = (manifest: CapabilityManifest): CapabilityContractIssue[] => {
  const role = manifest.appStatus;
  if (!role) return [];
  const issues: CapabilityContractIssue[] = [];
  for (const [localId, input, data] of [
    [role.summary, AppStatusSummaryInputSchema, AppStatusSummaryDataSchema],
    [role.detail, AppStatusDetailInputSchema, AppStatusDetailDataSchema],
  ] as const) {
    const query = manifest.queries.find((query) => query.localId === localId);
    if (!query) issues.push({ code: "kind", path: "$", message: `Missing app-status Query ${localId}` });
    else {
      issues.push(...capabilityContractIssues({ kind: "query", input, data }, { kind: "query", operation: query }));
      if (query.appOnly || query.openWorld)
        issues.push({ code: "kind", path: "$", message: "App-status Queries must be closed-world and person-readable" });
    }
  }
  const action = manifest.actions.find((action) => action.localId === role.forget);
  if (!action) issues.push({ code: "kind", path: "$", message: `Missing app-status Action ${role.forget}` });
  else
    issues.push(
      ...capabilityContractIssues(
        { kind: "action", input: AppStatusForgetInputSchema, data: AppStatusForgetDataSchema, idempotency: "required" },
        { kind: "action", operation: action },
      ),
    );
  return issues;
};
