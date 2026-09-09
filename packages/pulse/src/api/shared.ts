import type { User } from "@k2b/cloud/contracts";
import { type AuthContext, err, fail, ok, type Result } from "@k2b/cloud/server";
import type { Context } from "hono";
import { SHORT_ID_REGEX } from "../lib/short-id";
import { type AccessScope, accessScopeFor } from "../service/access-control";
import {
  type PulseBaseResourceTable,
  type PulsePublicResourceTable,
  resolveBasePublicId,
  resolvePublicId,
} from "../service/public-resources";

export const requireParam = (value: string | undefined, label: string) =>
  value ? { ok: true as const, value } : { ok: false as const, result: fail(err.badInput(`Missing ${label}`)) };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requireUuidParam = (value: string | undefined, label: string) => {
  const param = requireParam(value, label);
  if (!param.ok) return param;
  return UUID_RE.test(param.value) ? param : { ok: false as const, result: fail(err.badInput(`${label} must be a UUID`)) };
};

export const requirePublicIdParam = async (value: string | undefined, label: string, table: PulsePublicResourceTable) => {
  const param = requireParam(value, label);
  if (!param.ok) return param;
  if (!SHORT_ID_REGEX.test(param.value))
    return { ok: false as const, result: fail(err.badInput(`${label} must be a 6-character short ID`)) };
  const internalId = await resolvePublicId(table, param.value);
  return internalId
    ? { ok: true as const, value: internalId, publicId: param.value }
    : { ok: false as const, result: fail(err.notFound(label)) };
};

export const requireBaseResourceParam = async (value: string | undefined, label: string, table: PulseBaseResourceTable, baseId: string) => {
  const param = requireParam(value, label);
  if (!param.ok) return param;
  if (!SHORT_ID_REGEX.test(param.value))
    return { ok: false as const, result: fail(err.badInput(`${label} must be a 6-character short ID`)) };
  const internalId = await resolveBasePublicId(table, baseId, param.value);
  return internalId
    ? { ok: true as const, value: internalId, publicId: param.value }
    : { ok: false as const, result: fail(err.notFound(label)) };
};

export const requireUserBackedActor = (c: Context<AuthContext>): Result<User> => {
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  return user ? ok(user) : fail(err.forbidden("This endpoint requires a user-backed actor"));
};

export const requestAccessScope = (c: Context<AuthContext>): AccessScope => {
  const scope = accessScopeFor(c.get("actor"), c.get("accessSubject"));
  if (!scope.ok) throw new Error(scope.error.message);
  return scope.data;
};

export const projectResult = async <T, U>(result: Promise<Result<T>> | Result<T>, project: (data: T) => Promise<U>): Promise<Result<U>> => {
  const resolved = await result;
  return resolved.ok ? ok(await project(resolved.data)) : fail(resolved.error);
};

export const resolveSourceInput = async <T extends object>(baseId: string, input: T): Promise<Result<T>> => {
  const value = "sourceId" in input ? input.sourceId : null;
  if (typeof value !== "string" || !value) return ok(input);
  const sourceId = await resolveBasePublicId("sources", baseId, value);
  return sourceId ? ok({ ...input, sourceId }) : fail(err.notFound("Source"));
};

export const withResolvedSource = async <T extends object, U>(
  baseId: string,
  input: T,
  run: (resolved: T) => Promise<Result<U>>,
): Promise<Result<U>> => {
  const resolved = await resolveSourceInput(baseId, input);
  return resolved.ok ? run(resolved.data) : fail(resolved.error);
};
