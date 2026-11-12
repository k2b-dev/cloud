import { z } from "zod";

const scope = z.string().regex(/^[a-z][a-z0-9_:.-]{0,39}$/);
const scopes = z
  .array(scope)
  .max(16)
  .refine((values) => new Set(values).size === values.length);
const token = z
  .object({ kind: z.enum(["user_access", "service_access", "user_id"]), expiresIn: z.number().int().min(1).max(3600) })
  .strict();

/** A trusted issuer supplies authority, never identity claims or its own app ID. */
export const OAuthAuthorityStatementSchema = z
  .object({
    clientId: z.string().min(1).max(256),
    subject: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("user"),
          userId: z.string().uuid(),
          authEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      z.object({ kind: z.literal("service_account"), serviceAccountId: z.string().uuid() }).strict(),
    ]),
    scopes,
    audiences: z
      .array(z.string().min(1).max(2048))
      .min(1)
      .max(52)
      .refine((values) => new Set(values).size === values.length),
    resource: z.string().min(1).max(2048).nullable(),
    nonce: z.string().nullable(),
    loginExpiresAt: z.string().datetime().nullable(),
    terminalLoginId: z.string().uuid().nullable(),
    tokens: z.array(token).min(1).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    const [access, id] = value.tokens;
    const service = value.subject.kind === "service_account";
    if (
      !access ||
      access.kind !== (service ? "service_access" : "user_access") ||
      (id && (service || id.kind !== "user_id" || !value.scopes.includes("openid"))) ||
      (service && (value.nonce !== null || value.loginExpiresAt !== null || value.terminalLoginId !== null)) ||
      (value.terminalLoginId !== null && value.loginExpiresAt === null)
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid OAuth token batch for the subject" });
    }
    if (value.resource !== null) {
      let valid = false;
      try {
        const url = new URL(value.resource);
        valid = !url.hash;
      } catch {
        /* Invalid absolute URI. */
      }
      if (!valid || value.audiences.length !== 1 || value.audiences[0] !== value.resource)
        ctx.addIssue({ code: "custom", message: "Resource must be the only audience and an absolute URI without a fragment" });
    }
  });
export type OAuthAuthorityStatement = z.infer<typeof OAuthAuthorityStatementSchema>;

export const OAuthDeviceApprovalRequestSchema = z
  .object({
    deviceAuthorizationId: z.string().uuid(),
    identifier: z.string().trim().min(1).max(254),
    clientId: z.string().min(1).max(256),
    clientName: z.string().min(1).max(120),
    scopes: scopes.refine((values) => values.length > 0 && !values.includes("admin")),
    lifetimeSeconds: z.number().int().min(1).max(7_776_000),
    grantExpiresAt: z.string().datetime(),
  })
  .strict();
export type OAuthDeviceApprovalRequest = z.infer<typeof OAuthDeviceApprovalRequestSchema>;

export const OAuthNewAccessNoticeSchema = z
  .object({
    familyId: z.string().uuid(),
    userId: z.string().uuid(),
    clientId: z.string().min(1).max(256),
    clientName: z.string().min(1).max(120),
    createdAt: z.string().datetime(),
  })
  .strict();
export type OAuthIssuerNewAccessNotice = z.infer<typeof OAuthNewAccessNoticeSchema>;
