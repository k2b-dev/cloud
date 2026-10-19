import { spyOn } from "bun:test";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

const rootDir = process.env.PROBE_ROOT;
const defineAppPath = process.env.PROBE_DEFINE_APP;
if (!rootDir || !defineAppPath) throw new Error("PROBE_ROOT and PROBE_DEFINE_APP are required");
process.chdir(rootDir);
const { plugin } = createConfig({ dev: false, rootDir });
Bun.plugin(plugin());

const watcher = await import("./runtime-watcher");
const coreRelease = spyOn(watcher, "registeredCoreRelease").mockReturnValue(process.env.PROBE_CORE_RELEASE);
const { defineApp }: typeof import("./define-app") = await import(defineAppPath);

const createServers = () =>
  process.argv.slice(2).map((id) => {
    const app = defineApp({
      id,
      name: id,
      icon: "ti ti-stack",
      description: "Stylesheet version probe",
      baseUrl: `http://${id}:3000`,
      routes: [`/app/${id}`],
    });
    const server = new Hono().get(`/app/${id}`, ...app.ssr(() => () => "body"));
    return { id, server };
  });

const render = async (servers: ReturnType<typeof createServers>) => {
  const result: Record<string, { status: number; hrefs: string[] }> = {};
  for (const { id, server } of servers) {
    const response = await server.request(`/app/${id}`);
    const html = await response.text();
    const hrefs = Array.from(html.matchAll(/<link rel="(?:icon|stylesheet)" href="([^"]+)"/g), (match) => match[1]!);
    result[id] = { status: response.status, hrefs };
  }
  console.log(JSON.stringify(result));
};

const servers = createServers();
await render(servers);
if (process.env.PROBE_NEXT_CORE_RELEASE) {
  coreRelease.mockReturnValue(process.env.PROBE_NEXT_CORE_RELEASE);
  await render(servers);
}
// Reuse this fourth child for a real development render without adding another restart probe.
if (process.env.PROBE_ALSO_DEVELOPMENT === "1") {
  process.env.NODE_ENV = "development";
  await render(createServers());
}
