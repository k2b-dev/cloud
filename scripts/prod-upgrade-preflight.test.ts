import { describe, expect, test } from "bun:test";
import cloudPackage from "../packages/cloud/package.json";
import {
  assessFleetState,
  type FleetResourceReport,
  findReleaseMismatches,
  isImmutableImage,
  parseComposeFiles,
} from "./prod-upgrade-preflight";

const scriptSource = await Bun.file(new URL("./prod-upgrade-preflight.ts", import.meta.url)).text();
const syncVersion = cloudPackage.dependencies["@k2b/sync"];
const app = {
  id: "core",
  name: "Core",
  icon: "cloud",
  description: "Core",
  baseUrl: "http://core:3000",
  routes: ["/"],
  runtime: { release: "sha-aabbccd", syncVersion },
};
const report: FleetResourceReport = {
  appId: "core",
  result: {
    health: { state: "ready", connection: "connected", pendingResources: 0, driftedResources: 0 },
    resources: [{ namespace: "prod", kind: "job", id: "jobs", owner: "core", state: "ready", detail: { deadLetters: 0 } }],
  },
};
const assess = (overrides: Partial<Parameters<typeof assessFleetState>[0]> = {}) =>
  assessFleetState({
    apps: [app],
    reports: [report],
    expectedAppIds: ["core"],
    expectedRelease: "sha-aabbccd",
    expectedNamespace: "prod",
    ...overrides,
  });

describe("production v6 fleet preflight", () => {
  test("uses only the Core inventory and resource broker with no mutation commands", () => {
    expect(scriptSource).not.toMatch(/"(?:POST|PUT|DELETE|PATCH)"/);
    expect(scriptSource).not.toMatch(/"docker",\s*"compose"[^\n]+"(?:up|down|pull|stop|restart)"/);
    expect(scriptSource).toContain('"/api/admin/sync"');
    expect(scriptSource).not.toContain('"/api/apps"');
  });
  test("passes a complete ready fleet on the expected release and namespace", () => {
    expect(assess()).toEqual([]);
  });
  test("missing app registration cannot produce a successful partial fleet report", () => {
    expect(assess({ expectedAppIds: ["core", "mail"] })).toContain("Expected app mail is missing from the live registry.");
    expect(assess({ apps: [], reports: [], expectedAppIds: [] })).toContain("Core reports no registered apps.");
    expect(assess({ reports: [] })).toContain("core has no Sync resource report.");
  });
  test("blocks an old-only fleet and unavailable app diagnostics", () => {
    expect(assess({ apps: [{ ...app, runtime: { ...app.runtime, syncVersion: "5.9.1" } }] })).toContain(
      `core does not report @k2b/sync ${syncVersion}.`,
    );
    expect(assess({ reports: [{ appId: "core", result: null, error: "HTTP 503" }] })).toContain("core: HTTP 503");
  });
  test("blocks disconnected health, drift, wrong namespace and dead letters", () => {
    const failures = assess({
      reports: [
        {
          appId: "core",
          result: {
            health: { state: "degraded", connection: "reconnecting", pendingResources: 1, driftedResources: 1 },
            resources: [{ namespace: "development", kind: "job", id: "jobs", owner: "core", state: "drifted", detail: { deadLetters: 2 } }],
          },
        },
      ],
    });
    expect(failures).toHaveLength(4);
    expect(failures.join(" ")).toContain("2 dead letters require review");
  });
  test("finds missing and unexpected runtime releases", () => {
    expect(findReleaseMismatches([app, { ...app, id: "old", runtime: undefined }], "sha-other")).toEqual([
      "core=sha-aabbccd",
      "old=unknown",
    ]);
  });
  test("reads compose.prod.yml unless --compose files are given", () => {
    expect(parseComposeFiles([])).toEqual(["compose.prod.yml"]);
    expect(parseComposeFiles(["--compose", "a.yml", "--compose=b.yml"])).toEqual(["a.yml", "b.yml"]);
    expect(() => parseComposeFiles(["--compose"])).toThrow("--compose requires a file path.");
    expect(() => parseComposeFiles(["--up"])).toThrow("Unknown argument --up.");
  });
  test("accepts the expected tag or a digest as immutable image references", () => {
    expect(isImmutableImage("ghcr.io/k2b-dev/cloud-core:sha-aabbccd", "sha-aabbccd")).toBe(true);
    expect(isImmutableImage(`ghcr.io/k2b-dev/cloud-core@sha256:${"a".repeat(64)}`, "sha-aabbccd")).toBe(true);
    expect(isImmutableImage("ghcr.io/k2b-dev/cloud-core:sha-other", "sha-aabbccd")).toBe(false);
    expect(isImmutableImage("ghcr.io/k2b-dev/cloud-core:latest", "sha-aabbccd")).toBe(false);
  });
});
