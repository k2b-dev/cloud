import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ratelimit } from "../server/ratelimit";
import { getGeoIp } from "../server/request-context/geoip";
import { bootstrapRateLimit } from "../services/app-bootstrap";
import { authenticateSignedAppRequest } from "./authenticate-app-request";

// Reuse the installation's admission budget with separate counters so optional
// country enrichment cannot consume identity invocation or bootstrap allowance.
const admission = async (kind: "ingress" | "key", id: string) =>
  ratelimit({ id: `ip-country-${kind}`, limit: await bootstrapRateLimit() }).check(id);

const Input = z.object({ ip: z.string().max(45) }).strict();

/** Core-only transport: no capability execution, address history, or interactive credentials. */
export const createIpCountryRoutes = () =>
  new Hono().post(
    "/",
    describeRoute({ hide: true }),
    async (c, next) => {
      const principal = await authenticateSignedAppRequest(c, "identity:invoke", {
        ingress: (id) => admission("ingress", id),
        admit: (id) => admission("key", id),
      });
      if (principal instanceof Response) return principal;
      return next();
    },
    // The helper's largest body is {"ip":"<45 ASCII characters>"} (54 bytes).
    bodyLimit({ maxSize: 54 }),
    async (c) => {
      let input: z.infer<typeof Input>;
      try {
        input = Input.parse(await c.req.json());
      } catch {
        // Never echo untrusted JSON or validation errors into the response or logs.
        return c.json({ code: "invalid_input" }, 400);
      }
      return c.json(getGeoIp().country(input.ip));
    },
  );
