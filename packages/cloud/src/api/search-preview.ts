import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { getApp, getCapability } from "../_internal/registry";
import { type BoundBlockView, BoundBlockViewSchema, bindView, validateBlocks } from "../blocks";
import { ErrorResponseSchema } from "../contracts";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import {
  type AuthContext,
  auth,
  expectUserBackedActor,
  jsonResponse,
  preferredLocale,
  type RequestAuthority,
  requiresAuth,
  v,
} from "../server";
import { dispatchCapability } from "./capabilities";
import { waitWithin } from "./fanout";

export const SearchPreviewQuerySchema = CloudResourceRefSchema;
export const SearchPreviewResponseSchema = z.object({ view: BoundBlockViewSchema.nullable() });

export type SearchPreviewDependencies = {
  getCapability?: typeof getCapability;
  getApp?: typeof getApp;
  dispatch?: typeof dispatchCapability;
};

/** Optional presentation only: the Type's reader authorizes the person's own request. */
async function readSearchPreview(
  params: { ref: z.infer<typeof CloudResourceRefSchema>; request: Request; authority: RequestAuthority; locale?: string },
  dependencies: SearchPreviewDependencies = {},
): Promise<BoundBlockView | null> {
  const { request, ref } = params;
  request.signal.throwIfAborted();
  const appId = cloudResourceRefAppId(ref);
  const capability = await (dependencies.getCapability ?? getCapability)(appId);
  if (!capability || capability.appId !== appId) return null;
  const reader = resolveCapabilityResourceReader(capability.manifest, ref);
  if (!reader) return null;
  request.signal.throwIfAborted();
  const response = await (dependencies.dispatch ?? dispatchCapability)({
    request,
    authority: params.authority,
    locale: params.locale,
    origin: "http",
    kind: "queries",
    appId,
    capabilityId: reader.localId,
    input: { id: ref.id },
  });
  if (!response.ok) return null;
  const body = await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES, request.signal);
  if (!body.ok) return null;
  const result = capabilityResultSchema(z.unknown(), { consumer: true }).safeParse(body.data);
  if (!result.success || !result.data.view) return null;
  const app = await (dependencies.getApp ?? getApp)(appId);
  if (!app || app.id !== appId) return null;
  request.signal.throwIfAborted();
  const view = bindView(result.data.view, result.data.data);
  validateBlocks(view.blocks, "preview", { appId, appPrefixes: app.routes, envelope: result.data });
  return view;
}

export function createSearchPreviewRoutes(
  dependencies: SearchPreviewDependencies & { authenticate?: MiddlewareHandler<AuthContext> },
  timeoutMs: number,
) {
  return new Hono<AuthContext>().use("/search/preview", dependencies.authenticate ?? auth.requireRole("authenticated")).get(
    "/search/preview",
    describeRoute({
      tags: ["Search"],
      summary: "Preview a search resource",
      description: "Calls the resource reader as the signed-in person. Unavailable previews return a null view.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SearchPreviewResponseSchema, "Bound reader view, or null for the search facts fallback"),
        400: jsonResponse(ErrorResponseSchema, "Invalid resource reference"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed actor required"),
      },
    }),
    v("query", SearchPreviewQuerySchema),
    async (c) => {
      expectUserBackedActor(c);
      c.header("Cache-Control", "private, no-store");
      // Reuse search's provider budget for registry access, credential exchange and the reader together.
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]);
      const request = new Request(c.req.raw, { signal });
      let view: BoundBlockView | null = null;
      try {
        view = await waitWithin(
          readSearchPreview(
            {
              ref: c.req.valid("query"),
              request,
              authority: auth.getAuthority(c),
              locale: preferredLocale(c.req.raw.headers),
            },
            dependencies,
          ),
          signal,
        );
      } catch {
        // Reader errors and existence remain opaque; the browser retains its search facts.
      }
      return c.json({ view });
    },
  );
}
