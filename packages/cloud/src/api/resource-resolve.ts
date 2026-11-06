import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { withCapabilityRequestTimeout } from "../_internal/capability-timeout";
import { RESOURCE_URL_MAX_LENGTH } from "../contracts/resource-pages";
import { ResolvedCloudResourceUrlSchema } from "../contracts/resource-resolution";
import { type AuthContext, auth, getLocale } from "../server";
import { resolveCloudResourceUrl } from "./resource-links";

const Input = z.object({ url: z.string().min(1).max(RESOURCE_URL_MAX_LENGTH) }).strict();
const NotFound = { error: "Resource not found" } as const;

export const createResourceResolveRoutes = (resolve = resolveCloudResourceUrl) =>
  new Hono<AuthContext>().post(
    "/resolve",
    auth.readOnly,
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Resources"],
      summary: "Resolve a Cloud URL through its authorized resource reader",
      requestBody: { required: true, content: { "application/json": { schema: resolver(Input) } } },
      responses: {
        200: { description: "Readable resource", content: { "application/json": { schema: resolver(ResolvedCloudResourceUrlSchema) } } },
        404: {
          description: "Resource not found",
          content: { "application/json": { schema: resolver(z.object({ error: z.literal(NotFound.error) })) } },
        },
      },
    }),
    async (c) => {
      try {
        // JSON may encode each UTF-16 unit as six bytes. Bound the envelope before parsing.
        const body = await readBoundedJson(c.req.raw, RESOURCE_URL_MAX_LENGTH * 6 + 100, c.req.raw.signal);
        const input = body.ok ? Input.safeParse(body.data) : null;
        if (!input?.success) return c.json(NotFound, 404);
        const result = await withCapabilityRequestTimeout(c, "query", () =>
          resolve({
            url: input.data.url,
            request: c.req.raw,
            authority: auth.getAuthority(c),
            locale: getLocale(c),
          }),
        );
        return result ? c.json(result, 200) : c.json(NotFound, 404);
      } catch {
        return c.json(NotFound, 404);
      }
    },
  );
