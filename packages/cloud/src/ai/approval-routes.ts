import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { listCapabilities } from "../_internal/registry";
import { ErrorResponseSchema } from "../contracts";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import { type AuthContext, auth, expectUserBackedActor, getLocale, jsonResponse, rateLimit, requiresAuth, v } from "../server";
import {
  AI_WEBSITE_APPROVAL_TOOL,
  type AiToolApprovalPreference,
  listAiToolApprovalPreferences,
  parseAiWebsiteApprovalScope,
  revokeAiToolApprovalPreference,
} from "./approvals";
import { buildAiCapabilityCatalog } from "./capabilities";
import { aiConversations } from "./store";

export type AiApprovalPreferenceView = AiToolApprovalPreference & {
  title: string;
  app: {
    id: string;
    name: string;
    icon: string;
    accent?: string;
  } | null;
  /** For a website approval: the exact origin it lets code read, and the Studio app it is limited to, if any. */
  website: { origin: string; resourceId: string | null } | null;
};

const AiApprovalPreferenceSchema = z.object({
  id: z.uuid(),
  toolName: z.string(),
  approvalScope: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  conversationId: z.uuid().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  title: z.string(),
  app: z
    .object({
      id: z.string(),
      name: z.string(),
      icon: z.string(),
      accent: z.string().optional(),
    })
    .nullable(),
  website: z.object({ origin: z.string(), resourceId: z.string().nullable() }).nullable(),
});

const AiApprovalPreferenceListSchema = z.object({ approvals: z.array(AiApprovalPreferenceSchema) });
const AiApprovalPreferenceParamSchema = z.object({ preferenceId: z.uuid() });
const AiApprovalPreferenceQuerySchema = z.object({ conversation: z.string().min(1).max(80).optional() });
const AiApprovalPreferenceDeleteSchema = z.object({ deleted: z.literal(true) });

type AiApprovalRouteDependencies = {
  limit?: MiddlewareHandler<AuthContext>;
  authenticate?: MiddlewareHandler<AuthContext>;
  listPreferences?: (actorUserId: string, options: { conversationId?: string }) => Promise<AiToolApprovalPreference[]>;
  revokePreference?: (actorUserId: string, preferenceId: string) => Promise<boolean>;
  listCapabilities?: () => Promise<CapabilityRegistryEntry[]>;
  /** Resolves a chat the user owns by its ID or short ID. */
  findConversation?: (ownerUserId: string, conversation: string) => Promise<{ id: string } | null>;
};

const findOwnConversation = async (ownerUserId: string, conversation: string) =>
  z.uuid().safeParse(conversation).success
    ? aiConversations.getConversation({ conversationId: conversation, ownerUserId })
    : aiConversations.getConversationByShortId({ shortId: conversation, ownerUserId });

const fallbackTitle = (toolName: string): string => {
  const label = toolName
    .replaceAll("__", " ")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : toolName;
};

export const createAiApprovalPreferenceRoutes = (dependencies: AiApprovalRouteDependencies = {}) => {
  const listPreferences = dependencies.listPreferences ?? listAiToolApprovalPreferences;
  const revokePreference = dependencies.revokePreference ?? revokeAiToolApprovalPreference;
  const registry = dependencies.listCapabilities ?? listCapabilities;
  const findConversation = dependencies.findConversation ?? findOwnConversation;

  return new Hono<AuthContext>()
    .use(dependencies.limit ?? rateLimit())
    .use("*", dependencies.authenticate ?? auth.requireRole("authenticated"))
    .get(
      "/",
      describeRoute({
        tags: ["AI"],
        summary: "List remembered AI approvals",
        description:
          "Lists AI tool approvals remembered for the current user, with titles in the request locale. Without `conversation`, it lists the approvals that apply everywhere; with it, those limited to that chat.",
        ...requiresAuth,
        responses: {
          200: jsonResponse(AiApprovalPreferenceListSchema, "Remembered approvals"),
          401: jsonResponse(ErrorResponseSchema, "Authentication required"),
          403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
          404: jsonResponse(ErrorResponseSchema, "Chat not found"),
        },
      }),
      v("query", AiApprovalPreferenceQuerySchema),
      async (c) => {
        const user = expectUserBackedActor(c);
        const requested = c.req.valid("query").conversation;
        const conversation = requested ? await findConversation(user.id, requested) : null;
        if (requested && !conversation) return c.json({ message: "Chat not found", code: "NOT_FOUND" }, 404);
        const [preferences, capabilities] = await Promise.all([
          listPreferences(user.id, conversation ? { conversationId: conversation.id } : {}),
          registry().catch(() => [] as CapabilityRegistryEntry[]),
        ]);
        const catalogByName = new Map(buildAiCapabilityCatalog(capabilities, getLocale(c)).map((entry) => [entry.name, entry]));
        const approvals: AiApprovalPreferenceView[] = preferences.map((preference) => {
          if (preference.toolName === AI_WEBSITE_APPROVAL_TOOL) {
            const website = parseAiWebsiteApprovalScope(preference.approvalScope);
            return {
              ...preference,
              title: URL.canParse(website.origin) ? new URL(website.origin).host : website.origin,
              app: null,
              website,
            };
          }
          const capability = catalogByName.get(preference.toolName);
          return {
            ...preference,
            website: null,
            title: capability?.display.title ?? fallbackTitle(preference.toolName),
            app: capability
              ? {
                  id: capability.appId,
                  name: capability.display.appName,
                  icon: capability.app.appIcon,
                  ...(capability.app.appAccent ? { accent: capability.app.appAccent } : {}),
                }
              : null,
          };
        });
        return c.json({ approvals });
      },
    )
    .delete(
      "/:preferenceId",
      describeRoute({
        tags: ["AI"],
        summary: "Revoke a remembered AI approval",
        description: "Revokes one remembered AI tool approval owned by the current user.",
        ...requiresAuth,
        responses: {
          200: jsonResponse(AiApprovalPreferenceDeleteSchema, "Approval revoked"),
          400: jsonResponse(ErrorResponseSchema, "Invalid approval id"),
          401: jsonResponse(ErrorResponseSchema, "Authentication required"),
          403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
          404: jsonResponse(ErrorResponseSchema, "Approval not found"),
        },
      }),
      v("param", AiApprovalPreferenceParamSchema),
      async (c) => {
        const user = expectUserBackedActor(c);
        const deleted = await revokePreference(user.id, c.req.valid("param").preferenceId);
        return deleted ? c.json({ deleted: true as const }) : c.json({ message: "Approval not found", code: "NOT_FOUND" }, 404);
      },
    );
};

export type AiApprovalPreferenceRoutes = ReturnType<typeof createAiApprovalPreferenceRoutes>;
