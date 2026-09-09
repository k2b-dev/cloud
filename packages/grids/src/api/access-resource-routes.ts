import { AccessEntrySchema, ErrorResponseSchema, GrantAccessSchema } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import {
  type AccessResourceType,
  type BaseAdminAuthorization,
  grantAccess,
  listBaseAccess,
  listCustomAppAccess,
  resolveResourceBinding,
  validateAccessPermission,
} from "../service/access";
import { type PublicResourceType, resolvePublicId } from "../service/public-resources";
import { apiMessages, type GridsApiMessages } from "./messages";
import { currentAccessSubject, currentActorUserId, currentCredentialPermission, currentResourceBoundBaseId, gateAt } from "./permissions";
import { v } from "./validator";

const AccessListSchema = z.array(AccessEntrySchema);
const CreatedAccessSchema = z.object({ accessId: z.string().uuid() });

type AccessRouteConfig = {
  resourceType: AccessResourceType;
  publicResourceType: Extract<PublicResourceType, "base" | "customApp">;
  path: string;
  param: string;
  label: string;
  notFound: (messages: GridsApiMessages) => string;
  resolveBaseId: (resourceId: string) => Promise<string | null>;
  list: (resourceId: string) => ReturnType<typeof listBaseAccess>;
};

type AccessRouteDeps = {
  gate: typeof gateAt;
  actorId: typeof currentActorUserId;
  authorization: (c: Context<AuthContext>) => BaseAdminAuthorization;
  resolvePublicId: (type: Extract<PublicResourceType, "base" | "customApp">, publicId: string) => Promise<string | null>;
};

const defaultDeps: AccessRouteDeps = {
  gate: gateAt,
  actorId: currentActorUserId,
  authorization: (c) => ({
    subject: currentAccessSubject(c),
    permissionCap: currentCredentialPermission(c),
    resourceBoundBaseId: currentResourceBoundBaseId(c),
  }),
  resolvePublicId,
};

const CONFIGS = {
  base: {
    resourceType: "base",
    publicResourceType: "base",
    path: "/by-base/:baseId",
    param: "baseId",
    label: "Base",
    notFound: (messages) => messages.baseNotFound,
    resolveBaseId: async (baseId) => baseId,
    list: listBaseAccess,
  },
  customApp: {
    resourceType: "customApp",
    publicResourceType: "customApp",
    path: "/by-custom-app/:customAppId",
    param: "customAppId",
    label: "Grids App",
    notFound: (messages) => messages.gridsAppNotFound,
    resolveBaseId: async (customAppId) =>
      (await resolveResourceBinding("customApp", customAppId, { includeDeleted: false }))?.baseId ?? null,
    list: listCustomAppAccess,
  },
} as const satisfies Record<AccessResourceType, AccessRouteConfig>;

const resourceId = (c: Context<AuthContext>, config: AccessRouteConfig): string => c.req.param()[config.param]!;

const resolveResourceId = async (c: Context<AuthContext>, config: AccessRouteConfig, deps: AccessRouteDeps): Promise<string | null> => {
  const parsed = ShortIdSchema.safeParse(resourceId(c, config));
  return parsed.success ? deps.resolvePublicId(config.publicResourceType, parsed.data) : null;
};

const listResource = async (c: Context<AuthContext>, config: AccessRouteConfig, deps: AccessRouteDeps) => {
  const id = await resolveResourceId(c, config, deps);
  if (!id) return c.json({ message: config.notFound(apiMessages(c)) }, 404);
  const baseId = await config.resolveBaseId(id);
  if (!baseId) return c.json({ message: config.notFound(apiMessages(c)) }, 404);
  const gate = await deps.gate(c, { baseId }, "admin");
  if (!gate.ok) return respond(c, () => Promise.resolve(gate));
  return c.json(await config.list(id));
};

const grantResource = async (
  c: Context<AuthContext>,
  config: AccessRouteConfig,
  body: z.infer<typeof GrantAccessSchema>,
  deps: AccessRouteDeps,
) => {
  const id = await resolveResourceId(c, config, deps);
  if (!id) return c.json({ message: config.notFound(apiMessages(c)) }, 404);
  const baseId = await config.resolveBaseId(id);
  if (!baseId) return c.json({ message: config.notFound(apiMessages(c)) }, 404);
  const validationError = validateAccessPermission(config.resourceType, body.permission, getLocale(c));
  if (validationError) return c.json({ message: validationError }, 400);
  const gate = await deps.gate(c, { baseId }, "admin");
  if (!gate.ok) return respond(c, () => Promise.resolve(gate));
  return respond(
    c,
    () =>
      grantAccess({
        resourceType: config.resourceType,
        resourceId: id,
        actorId: deps.actorId(c),
        authorization: deps.authorization(c),
        locale: getLocale(c),
        ...body,
      }),
    201,
  );
};

const listDescription = (config: AccessRouteConfig) =>
  describeRoute({
    tags: ["Grids:Access"],
    summary: `List ACL entries for a ${config.label.toLowerCase()}`,
    responses: {
      200: jsonResponse(AccessListSchema, "Entries"),
      403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      404: jsonResponse(ErrorResponseSchema, `${config.label} not found`),
    },
  });

const grantDescription = (config: AccessRouteConfig) =>
  describeRoute({
    tags: ["Grids:Access"],
    summary: `Grant access on a ${config.label.toLowerCase()}`,
    responses: {
      201: jsonResponse(CreatedAccessSchema, "Created"),
      400: jsonResponse(ErrorResponseSchema, "Invalid permission"),
      403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      404: jsonResponse(ErrorResponseSchema, `${config.label} not found`),
    },
  });

export const createAccessResourceRoutes = (deps: AccessRouteDeps = defaultDeps) =>
  new Hono<AuthContext>()
    .get(CONFIGS.base.path, listDescription(CONFIGS.base), (c) => listResource(c, CONFIGS.base, deps))
    .post(CONFIGS.base.path, grantDescription(CONFIGS.base), v("json", GrantAccessSchema), (c) =>
      grantResource(c, CONFIGS.base, c.req.valid("json"), deps),
    )
    .get(CONFIGS.customApp.path, listDescription(CONFIGS.customApp), (c) => listResource(c, CONFIGS.customApp, deps))
    .post(CONFIGS.customApp.path, grantDescription(CONFIGS.customApp), v("json", GrantAccessSchema), (c) =>
      grantResource(c, CONFIGS.customApp, c.req.valid("json"), deps),
    );

export const accessResourceRoutes = createAccessResourceRoutes();
