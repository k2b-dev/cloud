import { type AuthContext, auth, rateLimit, v } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { ssr } from "../config";
import oauthRoutes from "../oauth";
import consentPage from "./consent";
import { ConsentDecisionSchema, completeConsent } from "./consent-action";
import devicePage from "./device";
import { completeDeviceDecision, DeviceDecisionSchema } from "./device-action";
import oauthErrorPage from "./error";
import oauthPage from "./page";

const consentHeaders =
  (referrerPolicy: "no-referrer" | "same-origin"): MiddlewareHandler =>
  async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", referrerPolicy);
    await next();
  };
// The device page's decision form is checked by Origin; with `no-referrer` browsers send `Origin: null`.
// `same-origin` keeps the user code out of cross-origin referrers while sending the real origin to Cloud.
const devicePageHeaders = consentHeaders("same-origin");

export default new Hono<AuthContext>()
  .get(
    "/oauth/consent",
    consentHeaders("no-referrer"),
    auth.requireRole("authenticated", ssr.access),
    auth.requireUser(ssr.access),
    ...consentPage,
  )
  .post("/oauth/consent", rateLimit(), auth.requireRole("authenticated"), auth.requireUser(), v("form", ConsentDecisionSchema), (c) =>
    completeConsent(c, c.req.valid("form")),
  )
  .get(
    "/oauth/device",
    devicePageHeaders,
    rateLimit(),
    auth.requireRole("authenticated", ssr.access),
    auth.requireUser(ssr.access),
    ...devicePage,
  )
  .post(
    "/oauth/device",
    devicePageHeaders,
    rateLimit(),
    auth.requireRole("authenticated"),
    auth.requireUser(),
    v("form", DeviceDecisionSchema),
    (c) => completeDeviceDecision(c, c.req.valid("form")),
  )
  .route("/", oauthRoutes)
  .get("/admin/oauth", auth.requireRole("admin", ssr.access), ...oauthPage)
  .get("/oauth/error", auth.requireRole("*"), ...oauthErrorPage);
