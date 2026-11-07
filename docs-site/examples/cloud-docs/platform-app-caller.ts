import { defineApp } from "@k2b/cloud";
import { appCaller, geoClient, rateLimit } from "@k2b/cloud/server";
import { Hono } from "hono";

const app = defineApp({
  id: "website",
  name: "Website",
  description: "A public registration website.",
  icon: "ti ti-world",
  baseUrl: "http://website:3000",
  routes: ["/app/website"],
  public: true,
  platformPermissions: ["geo:query"],
});

app.public.get("/address-suggestions", rateLimit({ keyBy: "ip" }), async (c) => {
  const result = await geoClient.autocomplete({ text: c.req.query("text") ?? "" }, appCaller({ signal: c.req.raw.signal }));
  if (!result.ok && result.error.retryAfterMs) c.header("Retry-After", String(Math.ceil(result.error.retryAfterMs / 1000)));
  const response = c.json(result.ok ? result.data : { code: result.error.code, message: result.error.message });
  return new Response(response.body, { status: result.ok ? 200 : result.error.status, headers: response.headers });
});

const routes = new Hono().get("/app/website", (c) => c.html("<h1>Website</h1>"));
export default await app.start({ fetch: routes.fetch });
