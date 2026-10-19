import { spyOn } from "bun:test";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

// The parent test passes everything as one JSON argument; NODE_ENV comes from the child's environment.
const probe = JSON.parse(process.argv[2] ?? "{}") as {
  root: string;
  defineApp: string;
  apps: string[];
  coreRelease?: string;
  nextCoreRelease?: string;
};
const rootDir = probe.root;
process.chdir(rootDir);
const { plugin } = createConfig({ dev: false, rootDir });
Bun.plugin(plugin());

const watcher = await import("./runtime-watcher");
const coreRelease = spyOn(watcher, "registeredCoreRelease").mockReturnValue(probe.coreRelease);
const { defineApp }: typeof import("./define-app") = await import(probe.defineApp);

const createServers = () =>
  probe.apps.map((id) => {
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
if (probe.nextCoreRelease) {
  coreRelease.mockReturnValue(probe.nextCoreRelease);
  await render(servers);
}
