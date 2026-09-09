import { err, fail, ok, type PageParams, type Paginated, paginate, type Result, type ServiceError } from "@k2b/cloud/server";
import type { MutationResult } from "@/contracts";
import { oauth } from "./oauth";

type MutationStatus = Extract<MutationResult, { ok: false }>["status"];
type OAuthClient = Awaited<ReturnType<typeof oauth.clients.list>>["items"][number];

/**
 * Maps mutation status codes into the shared service error format.
 */
const toServiceError = (status: MutationStatus, message: string): ServiceError => {
  if (status === 400) return err.badInput(message);
  if (status === 401) return err.unauthenticated(message);
  if (status === 403) return err.forbidden(message);
  if (status === 404) return err.notFound("Client");
  if (status === 409) return { code: "CONFLICT", message, status };
  return err.internal(message);
};

const fromMutation = <T>(result: MutationResult<T>): Result<T> => {
  if (result.ok) return ok(result.data);
  return fail(toServiceError(result.status, result.error));
};

export const oauthService = {
  client: {
    list: async (config?: { pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<OAuthClient>> => {
      const { page, perPage, offset } = paginate(config?.pagination);
      const result = await oauth.clients.list({ limit: perPage, offset, query: config?.filter?.query });
      return {
        items: result.items,
        page,
        perPage,
        total: result.total,
        hasNext: page * perPage < result.total,
      };
    },
    summary: () => oauth.clients.summary(),
    get: async (config: { id: string }) => oauth.clients.get({ id: config.id }),
    create: async (config: Parameters<typeof oauth.clients.create>[0]) => fromMutation(await oauth.clients.create(config)),
    update: async (config: Parameters<typeof oauth.clients.update>[0]) => fromMutation(await oauth.clients.update(config)),
    remove: async (config: { id: string; actor: Parameters<typeof oauth.clients.delete_>[0]["actor"] }) =>
      fromMutation(await oauth.clients.delete_(config)),
    regenerateSecret: async (config: Parameters<typeof oauth.clients.regenerateSecret>[0]) =>
      fromMutation(await oauth.clients.regenerateSecret(config)),
  },
};

export type OauthService = typeof oauthService;
