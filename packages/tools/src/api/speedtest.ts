import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { app } from "../config";

export const readSpeedtestConfig = async () => ({
  server: await app.settings.get("tools.speedtest_server"),
  enabled: await app.settings.get("tools.speedtest_enabled"),
});

const moved = {
  code: "SPEEDTEST_MOVED",
  message:
    "Measurements and scripts moved to the standalone speedtest server. Use cld tools speedtest, or download /cli from the server shown on /tools/speedtest. Python scripts are no longer supplied. No redirect is performed.",
  settings: "/tools/api/speedtest/config",
  page: "/tools/speedtest",
};
const migration = describeRoute({
  summary: "Legacy speedtest URL: migration notice",
  description:
    "Cloud measurement endpoints and /cli have moved. The retired Python script /tools/api/speedtest/cli.py also returns 410. No request is redirected to the measurement server.",
  deprecated: true,
  responses: { 410: { description: "Moved to the standalone measurement server; no redirect or measurement." } },
});

export function createSpeedtestRoutes(readConfig = readSpeedtestConfig) {
  return new Hono<AuthContext>()
    .get(
      "/config",
      describeRoute({
        summary: "Public speedtest server and availability",
        responses: {
          200: {
            description: "Anonymous measurement target and operator switch.",
            content: { "application/json": { schema: resolver(z.object({ server: z.string(), enabled: z.boolean() })) } },
          },
        },
      }),
      async (c) => c.json(await readConfig(), 200, { "Cache-Control": "no-store" }),
    )
    .get("/ping", migration, (c) => c.json(moved, 410, { "Cache-Control": "no-store" }))
    .get("/download", migration, (c) => c.json(moved, 410, { "Cache-Control": "no-store" }))
    .post("/upload", migration, (c) => c.json(moved, 410, { "Cache-Control": "no-store" }))
    .get("/cli", migration, (c) =>
      c.text(
        `# Speedtest moved.
# Open /tools/speedtest for the selected server.
# Use cld tools speedtest, or download /cli from that standalone server.
# Cloud no longer supplies measurement scripts.
`,
        410,
        { "Cache-Control": "no-store" },
      ),
    )
    .get("/cli.py", migration, (c) =>
      c.text(
        `# Speedtest moved. Python scripts are no longer supplied.
# Use cld tools speedtest or the standalone server's /cli (Node/Bun).
`,
        410,
        { "Cache-Control": "no-store" },
      ),
    );
}
export default createSpeedtestRoutes();
