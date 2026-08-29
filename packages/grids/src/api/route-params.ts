import type { Context, MiddlewareHandler } from "hono";
import { ShortIdSchema } from "../contracts";
import { type PublicResourceType, resolvePublicId, resolveStoredPublicId } from "../service/public-resources";
import { apiMessages, type GridsApiMessages } from "./messages";

const resolvedParams = new WeakMap<Request, Map<string, string>>();

type ResourceLabel =
  | "Base"
  | "Combined table"
  | "Comment"
  | "Document"
  | "Email template"
  | "Field"
  | "File"
  | "Form"
  | "Grids App"
  | "Record"
  | "Source table"
  | "Table"
  | "View"
  | "Workflow run";

const notFoundMessage = (messages: GridsApiMessages, resource: ResourceLabel): string => {
  const byResource: Record<ResourceLabel, string> = {
    Base: messages.baseNotFound,
    "Combined table": messages.combinedTableNotFound,
    Comment: messages.commentNotFound,
    Document: messages.documentNotFound,
    "Email template": messages.emailTemplateNotFound,
    Field: messages.fieldNotFound,
    File: messages.fileNotFound,
    Form: messages.formNotFound,
    "Grids App": messages.gridsAppNotFound,
    Record: messages.recordNotFound,
    "Source table": messages.sourceTableNotFound,
    Table: messages.tableNotFound,
    View: messages.viewNotFound,
    "Workflow run": messages.workflowRunNotFound,
  };
  return byResource[resource];
};

export const publicIdParam = (context: Context, name: string): string | null => {
  const parsed = ShortIdSchema.safeParse(context.req.param(name));
  return parsed.success ? parsed.data : null;
};

export const resolvePublicIdParam = async (context: Context, name: string, type: PublicResourceType): Promise<string | null> => {
  const publicId = publicIdParam(context, name);
  if (!publicId) return null;
  const internalId = await resolvePublicId(type, publicId);
  if (internalId) {
    const params = resolvedParams.get(context.req.raw) ?? new Map<string, string>();
    params.set(name, internalId);
    resolvedParams.set(context.req.raw, params);
  }
  return internalId;
};

export const resolveStoredPublicIdParam = async (context: Context, name: string, type: PublicResourceType): Promise<string | null> => {
  const publicId = publicIdParam(context, name);
  if (!publicId) return null;
  const internalId = await resolveStoredPublicId(type, publicId);
  if (internalId) {
    const params = resolvedParams.get(context.req.raw) ?? new Map<string, string>();
    params.set(name, internalId);
    resolvedParams.set(context.req.raw, params);
  }
  return internalId;
};

export const internalIdParam = (context: Context, name: string): string | null => resolvedParams.get(context.req.raw)?.get(name) ?? null;

export const requirePublicIdParam =
  (
    name: string,
    type: PublicResourceType,
    resource: ResourceLabel,
    resolve: (type: PublicResourceType, publicId: string) => Promise<string | null> = resolvePublicId,
  ): MiddlewareHandler =>
  async (context, next) => {
    const publicId = publicIdParam(context, name);
    const internalId = publicId ? await resolve(type, publicId) : null;
    if (!internalId) return context.json({ message: notFoundMessage(apiMessages(context), resource) }, 404);
    const params = resolvedParams.get(context.req.raw) ?? new Map<string, string>();
    params.set(name, internalId);
    resolvedParams.set(context.req.raw, params);
    await next();
  };

export const requireStoredPublicIdParam =
  (name: string, type: PublicResourceType, resource: ResourceLabel): MiddlewareHandler =>
  async (context, next) => {
    if (!(await resolveStoredPublicIdParam(context, name, type))) {
      return context.json({ message: notFoundMessage(apiMessages(context), resource) }, 404);
    }
    await next();
  };
