import { Hono } from "hono";
import { z } from "zod";
import { verifyCodeOwnerRead } from "../code/owner-proof";
import type { CapabilityDefinitions } from "../contracts/capabilities";
import { CAPABILITY_MAX_REQUEST_BYTES, CloudResourceRefSchema } from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import { readBoundedJson } from "./bounded-json";
import { withCapabilityRequestTimeout } from "./capability-timeout";

/** Read-only Core projection for the owner existence/title guard; never target rights. */
export const createCodeOwnerRoutes = (appId: string, definitions: CapabilityDefinitions) => {
  const router = new Hono();
  router.post("/queries/code.owner.title", (c) =>
    withCapabilityRequestTimeout(c, "query", async () => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      const claims = token && (await verifyCodeOwnerRead(token, appId));
      if (!claims) return c.json({ code: "FORBIDDEN" }, 403);
      const body = await readBoundedJson(c.req.raw, CAPABILITY_MAX_REQUEST_BYTES);
      const parsed = CloudResourceRefSchema.safeParse(body.ok ? body.data : undefined);
      if (!parsed.success || !parsed.data.type.startsWith(`${appId}.`)) return c.json({ code: "FORBIDDEN" }, 403);
      const ref = parsed.data,
        localType = ref.type.slice(appId.length + 1);
      const type = definitions.types?.[localType];
      const reader = type?.reader && definitions.queries?.[type.reader];
      if (!definitions.code?.owners?.includes(localType) || !reader || !reader.codeResourceTitle)
        return c.json({ code: "OWNER_READER_UNAVAILABLE" }, 503);
      try {
        const title = await sql.begin(async (tx) => {
          await tx`SET TRANSACTION READ ONLY`;
          const [account] = await tx`SELECT id FROM auth.service_accounts WHERE id=${claims.principal}::uuid
          AND kind='code' AND status='active' AND name=${`code:${ref.type}:${ref.id}`}`;
          if (!account) return undefined;
          return z
            .string()
            .min(1)
            .max(500)
            .nullable()
            .parse(await reader.codeResourceTitle!(tx, ref.id));
        });
        return title === undefined ? c.json({ code: "FORBIDDEN" }, 403) : c.json({ data: { title } });
      } catch {
        return c.json({ code: "OWNER_READER_UNAVAILABLE" }, 503);
      }
    }),
  );
  return router;
};
