import { z } from "zod";
import { APP_APPROVAL_LIMITS } from "./app-approval";
import { CapabilityActionReviewSchema, CapabilityAppIdSchema } from "./capabilities";

export { APPROVALS_API_PATH, APPROVAL_COUNTS_PATH, APPROVALS_PAGE_PATH } from "./approval-paths";

/**
 * Pending Action approvals as every app lists and decides them: one Core route under `/api/approvals` and the
 * `Approvals` component from `@k2b/cloud/approvals/ui`. A list shows only the signed-in person's own open requests.
 */

/** One page of a list, the same as a Cloud Login inbox page. */
export const APPROVALS_PAGE_SIZE = APP_APPROVAL_LIMITS.pageSize;

/**
 * A client that relays decisions from an editor over the Agent Client Protocol sends this header with the value
 * `acp`. Such a client may reject any request, but approves only `standard` ones. Cloud cannot verify the header: it is
 * the bridge's own declaration, which keeps the editor that drives the bridge from approving a `confirm` request.
 */
export const APPROVAL_CLIENT_HEADER = "x-cloud-client";
export const APPROVAL_ACP_CLIENT = "acp";

export const ApprovalListQuerySchema = z
  .object({
    /** Requests whose effect belongs to this app, or that this app asked for. */
    app: CapabilityAppIdSchema.optional(),
    /** Requests whose review links to this same-origin path, such as the draft a send Action would send. */
    link: z.string().startsWith("/").max(2048).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;

export const PendingApprovalSchema = z
  .object({
    id: z.uuid(),
    /** The app that owns the effect, named from the registry in the reader's language. */
    app: z.object({ id: z.string(), name: z.string(), icon: z.string().nullable() }).strict(),
    action: z.string(),
    /** `confirm` asks every time and never offers to remember; `standard` may offer it. */
    assurance: z.enum(["standard", "confirm"]),
    /** What the person reads: the first line names the app and the Action, later lines add `Label: value` details. */
    sentence: z.string(),
    /** The owning app's review as the person saw it when Cloud asked. */
    review: CapabilityActionReviewSchema.nullable(),
    /** Where the request waits. The title is chat content, written by a person or a model, never Cloud's own words. */
    requester: z.object({ kind: z.literal("chat"), appId: z.string(), title: z.string().nullable(), href: z.string() }).strict(),
    /** Ways the person may remember this approval, the same the chat card offers. */
    remember: z.object({ chat: z.boolean(), always: z.boolean(), website: z.boolean() }).strict(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const ApprovalPageSchema = z
  .object({
    items: z.array(PendingApprovalSchema).max(APPROVALS_PAGE_SIZE),
    nextCursor: z.string().nullable(),
    /** Open requests that match the query, across all pages. */
    count: z.number().int().nonnegative(),
    /** Open requests of the person that do not match the query; 0 without `app` or `link`. */
    elsewhere: z.number().int().nonnegative(),
  })
  .strict();
export type ApprovalPage = z.infer<typeof ApprovalPageSchema>;

export const ApprovalCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    /** Per app ID: open requests whose effect belongs to the app or that the app asked for, as `?app=` lists them. */
    apps: z.record(z.string(), z.number().int().positive()),
  })
  .strict();
export type ApprovalCounts = z.infer<typeof ApprovalCountsSchema>;

export const ApprovalDecisionInputSchema = z.object({ approved: z.boolean(), remember: z.enum(["chat", "always"]).optional() }).strict();
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;

export const ApprovalDecisionResultSchema = z.object({ status: z.enum(["approved", "rejected"]) }).strict();
export type ApprovalDecisionResult = z.infer<typeof ApprovalDecisionResultSchema>;
