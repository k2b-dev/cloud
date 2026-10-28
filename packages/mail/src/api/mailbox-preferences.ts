import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { MAX_MAILBOX_PREFERENCES, ResourceShortIdSchema } from "../contracts";
import { mailDoneTodayCountsSchema, mailViewPreferenceChangeSchema, mailViewPreferenceSchema } from "../mail-view-preference";
import { type MailRequestContext, mailboxPreferences } from "../service";
import { getMailboxDoneTodayCounts } from "../service/done-today";
import { internalMailboxId, type MailApiContext, mailboxParamSchema, resolveMailboxParam, respondPublic } from "./public-resource-boundary";

const mailboxPreferencesSchema = z.object({
  pinnedMailboxIds: z.array(ResourceShortIdSchema).describe("Mailboxes pinned to the top of your overview, most recently pinned first"),
  hiddenMailboxIds: z
    .array(ResourceShortIdSchema)
    .describe("Mailboxes hidden from your overview, most recently hidden first; pass them as excludeMailboxIds to leave them out of Focus"),
});
const mailboxPreferenceChangeSchema = z
  .object({
    pinned: z.boolean().optional().describe("Pin the mailbox to the top of your overview, or unpin it"),
    hidden: z.boolean().optional().describe("Hide the mailbox from your overview and Focus, or show it again"),
  })
  .refine((value) => value.pinned !== undefined || value.hidden !== undefined, "Set pinned, hidden, or both");
const mailboxPreferenceSchema = z.object({ pinned: z.boolean(), hidden: z.boolean() });

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

export default new Hono<MailApiContext>()
  .get(
    "/mailboxes/preferences",
    describeRoute({
      tags: ["Mail:Mailboxes"],
      summary: "List your pinned and hidden mailboxes",
      description:
        `Returns the mailboxes you pinned or hid in your overview, among those you can still read, at most ${MAX_MAILBOX_PREFERENCES} of each. ` +
        "Focus does not read them: pass the hidden ones as excludeMailboxIds to see Focus as your overview shows it.",
      ...requiresAuth,
      responses: { 200: jsonResponse(mailboxPreferencesSchema, "Your pinned and hidden mailboxes") },
    }),
    async (c) => respondPublic(c, ok(await mailboxPreferences.listMailboxPreferences(requestContext(c)))),
  )
  .get(
    "/mailboxes/:mailboxId/view",
    describeRoute({
      tags: ["Mail:Mailboxes"],
      summary: "Read your mailbox view for both device classes",
      ...requiresAuth,
      responses: {
        200: jsonResponse(mailViewPreferenceSchema, "Your view, defaulting to auto and compact"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Mailbox not found"),
      },
    }),
    resolveMailboxParam,
    v("param", mailboxParamSchema),
    async (c) => respondPublic(c, mailboxPreferences.getMailboxViewPreference(requestContext(c), internalMailboxId(c))),
  )
  .patch(
    "/mailboxes/:mailboxId/view",
    describeRoute({
      tags: ["Mail:Mailboxes"],
      summary: "Choose your mailbox view",
      description:
        "Mailbox read access is enough. Omitted device classes keep their stored value. Applies only to the current person and mailbox.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(mailViewPreferenceSchema, "Your view"),
        400: jsonResponse(ErrorResponseSchema, "Invalid or empty view change"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Mailbox not found"),
      },
    }),
    resolveMailboxParam,
    v("param", mailboxParamSchema),
    v("json", mailViewPreferenceChangeSchema),
    async (c) =>
      respondPublic(c, mailboxPreferences.setMailboxViewPreference(requestContext(c), internalMailboxId(c), c.req.valid("json"))),
  )
  .get(
    "/mailboxes/:mailboxId/done-today",
    describeRoute({
      tags: ["Mail:Conversations"],
      summary: "Count visible conversations completed today",
      description:
        "Uses the Core time zone, falling back to Europe/Berlin. Each conversation counts once; its latest completion today determines automation attribution. Reopened conversations still count.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(mailDoneTodayCountsSchema, "Today's completed conversations, including those completed by automation"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Mailbox not found"),
      },
    }),
    resolveMailboxParam,
    v("param", mailboxParamSchema),
    async (c) => respondPublic(c, getMailboxDoneTodayCounts(requestContext(c), internalMailboxId(c))),
  )
  .patch(
    "/mailboxes/:mailboxId/preference",
    describeRoute({
      tags: ["Mail:Mailboxes"],
      summary: "Pin or hide a mailbox in your overview",
      description:
        "Changes only your own overview, on every device. A hidden mailbox leaves the mailbox list and Focus; " +
        "it stays connected and opens directly. A field you leave out keeps its current value. " +
        `You can pin at most ${MAX_MAILBOX_PREFERENCES} mailboxes and hide at most ${MAX_MAILBOX_PREFERENCES}.`,
      ...requiresAuth,
      responses: {
        200: jsonResponse(mailboxPreferenceSchema, "Your preference for this mailbox"),
        400: jsonResponse(
          ErrorResponseSchema,
          `Neither pinned nor hidden is set, or ${MAX_MAILBOX_PREFERENCES} mailboxes are already pinned or hidden`,
        ),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Mailbox not found"),
      },
    }),
    resolveMailboxParam,
    v("param", mailboxParamSchema),
    v("json", mailboxPreferenceChangeSchema),
    async (c) => respondPublic(c, mailboxPreferences.setMailboxPreference(requestContext(c), internalMailboxId(c), c.req.valid("json"))),
  );
