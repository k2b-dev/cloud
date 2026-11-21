import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

/** Calls older than this are not counted; Code runs and their calls are kept for the same thirty days. */
export const CODE_USAGE_WINDOW_DAYS = 30;
/** Active Codes one answer looks at, in ID order. */
export const CODE_USAGE_CODES_MAX = 500;
/** Named entries in one answer; every further match counts in `others`. */
export const CODE_USAGE_ITEMS_MAX = 50;
/** Permission checks per request: twice the named items, newest call first; the rest counts without names. */
export const CODE_USAGE_CHECKS_MAX = 2 * CODE_USAGE_ITEMS_MAX;

/** One Code page or automation that read the resource and that the asking person may open. */
export const CodeUsageItemSchema = z
  .object({
    codeId: z.string().min(1),
    title: z.string().max(200),
    kind: z.enum(["page", "automation"]),
    /** Who owns the Code, as the page label names it to members; null when the owner cannot be told. */
    owner: z.string().min(1).max(200).nullable(),
    /** The latest succeeded Query of this Code that read the resource. */
    lastCalledAt: z.iso.datetime({ offset: true }),
    /** The page itself, or the automation's Code page in Core. */
    href: z.string().startsWith("/"),
  })
  .strict();
export type CodeUsageItem = z.infer<typeof CodeUsageItemSchema>;

export const CodeUsageSchema = z
  .object({
    /** Newest call first, at most `CODE_USAGE_ITEMS_MAX`. */
    items: z.array(CodeUsageItemSchema).max(CODE_USAGE_ITEMS_MAX),
    /** Matches without a name: Codes the person may not open, and those beyond the item limit. */
    others: z.number().int().nonnegative(),
    /** Start of the counted window. */
    since: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CodeUsage = z.infer<typeof CodeUsageSchema>;

/**
 * `GET /api/code/usage?type=<qualified type>&id=<resource id>`: which Code pages and automations read one resource
 * in the last thirty days (F4). Only signed-in members in their own browser session who may read the resource ask.
 * Success is `{ data: CodeUsage }`; errors are `{ code }` with `BAD_INPUT` 400, `code_usage_forbidden` 403 and
 * `code_usage_unavailable` 503. No per-person counts and no name of a Code the person may not open.
 */
export const codeUsageRoute = {
  path: "/api/code/usage",
  input: CloudResourceRefSchema,
  data: CodeUsageSchema,
};
