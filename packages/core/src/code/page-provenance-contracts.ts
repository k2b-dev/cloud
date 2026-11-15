import { z } from "zod";

/**
 * The feat/code label on a Code page and the card behind it (concept gustav-ui-neu v12, 3n). Hosting draws the pill
 * from `CodePageLabel` in the first paint; the card asks `codePageProvenanceRoutes.read` once on its first opening.
 * Both answer per viewer: a visitor without an account learns nothing about the owner or the automation.
 */

/** Who looks at the page, as the card distinguishes it. A signed-in guest on a public page is a `visitor`. */
export const CodePageViewerSchema = z.enum(["visitor", "member", "reader"]);
export type CodePageViewer = z.infer<typeof CodePageViewerSchema>;

/**
 * What the pill says in the first paint, from the statement that reads the active version (no extra statement).
 * A person's name only for members (F26); for an app its name; for a resource only its localized type title, never
 * its name (the card names it when the viewer may see it).
 */
export const CodePageLabelSchema = z.discriminatedUnion("kind", [
  /** Visitors without an account, signed-in guests, and members whose owner cannot be told: "Selbst gebaute Seite". */
  z.object({ kind: z.literal("anonymous") }).strict(),
  z.object({ kind: z.literal("person"), name: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("app"), name: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("resource"), type: z.string().min(1).max(200) }).strict(),
]);
export type CodePageLabel = z.infer<typeof CodePageLabelSchema>;

/** The owner row of the card ("Gehört zu"). */
export const CodePageOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), name: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("app"), name: z.string().min(1).max(200) }).strict(),
  /** `name` is null when the viewer may not see the resource: then only its type shows. */
  z.object({ kind: z.literal("resource"), type: z.string().min(1).max(200), name: z.string().min(1).max(200).nullable() }).strict(),
  /** The owner's provider did not answer ("lässt sich gerade nicht abrufen"). */
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type CodePageOwner = z.infer<typeof CodePageOwnerSchema>;

/** The card's facts for one viewer. Never more than the card shows. */
export const CodePageProvenanceSchema = z
  .object({
    viewer: CodePageViewerSchema,
    /** Null for visitors. */
    owner: CodePageOwnerSchema.nullable(),
    /** Only for viewers who may see the automation (`codePermission` reader or editor). */
    automation: z
      .object({
        title: z.string().min(1).max(200),
        version: z.number().int().positive(),
        /** When the running version was switched on (`code.activations`, state `active`). */
        activeSince: z.iso.datetime({ offset: true }),
        /** The deciding admin's display name; null when the version needed no approval. */
        approvedBy: z.string().min(1).max(200).nullable(),
        /** The automation's Code page for this viewer. */
        href: z.string().startsWith("/"),
      })
      .strict()
      .nullable(),
    /** What Cloud hands the page about the account: nothing on public routes or for visitors. */
    gives: z.enum(["nothing", "account"]),
    /** Members only: whether this person has an open report on this page, and since when. Null for visitors. */
    report: z
      .object({ reportedAt: z.iso.datetime({ offset: true }).nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type CodePageProvenance = z.infer<typeof CodePageProvenanceSchema>;

/** Optional reason chips of the report dialog, at most one. */
export const CODE_PAGE_REPORT_REASONS = ["security", "suspicious", "false_information", "illegal", "other"] as const;
export const CodePageReportReasonSchema = z.enum(CODE_PAGE_REPORT_REASONS);
export type CodePageReportReason = z.infer<typeof CodePageReportReasonSchema>;
/** One sentence is enough; the bound follows a short note, not an essay. */
export const CODE_PAGE_REPORT_TEXT_MAX = 2000;

/** Which page a request is about: the Code, the page path without query, and the opaque version value hosting sent. */
const pageRef = {
  codeId: z.string().min(1).max(200),
  /** The page's own path inside the Code, such as `/` or `/week`; no query. */
  path: z.string().startsWith("/").max(2048),
  /** Opaque value of the delivered version, like `codeCsrf`; a different running version answers `code_page_changed`. */
  version: z.string().min(16).max(256),
};

/**
 * Browser routes under `/api/code/pages`. Both admit exactly like the page itself (public route or member, no guest on
 * a non-public page), answer missing and inaccessible Code alike (404 `code_route_not_found`), and are rate limited.
 * Errors are `{ code }` with: `code_route_not_found` 404, `code_page_changed` 409, `code_sign_in_required` 401,
 * `code_members_only` 403, `code_report_members_only` 403, `code_request_rate_limit` / `code_report_rate_limit` 429,
 * `BAD_INPUT` 400. Success is `{ data }`.
 */
export const codePageProvenanceRoutes = {
  read: {
    path: "/api/code/pages/provenance",
    input: z.object(pageRef).strict(),
    data: CodePageProvenanceSchema,
  },
  report: {
    path: "/api/code/pages/report",
    input: z
      .object({
        ...pageRef,
        reason: CodePageReportReasonSchema.nullable(),
        text: z.string().trim().min(1).max(CODE_PAGE_REPORT_TEXT_MAX),
        /** Idempotency key from the dialog: a resend after a lost answer never files a second report. */
        key: z.uuid(),
      })
      .strict(),
    /** The open report of this person on this page, also when it existed already. */
    data: z.object({ reportedAt: z.iso.datetime({ offset: true }) }).strict(),
  },
} as const;

/**
 * What hosting hands the label island beside the tree, per request (`HostedCodePage.provenance`). Everything here is
 * safe for a visitor without an account: the label is already reduced to the viewer, the version value is opaque.
 */
export type CodePageProvenanceSeed = {
  label: CodePageLabel;
  /** Opaque value of the delivered version (`codePageVersionValue`). */
  version: string;
  /** The page's path inside the Code, without query. */
  path: string;
  /** `settings.app.name`, shown quietly under the card's title ("in Möbel Beispiel Cloud"). */
  cloudName: string;
};
