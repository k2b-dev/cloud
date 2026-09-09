import cloudPackage from "../packages/cloud/package.json";
import { assessRuntimeCompatibility } from "../packages/cloud/src/_internal/runtime-compatibility";
import type { AppRegistryEntry } from "../packages/cloud/src/contracts/registry";

const COMPOSE_FILE = "compose.prod.yml";
const EXPECTED_SYNC_VERSION = cloudPackage.dependencies["@k2b/sync"];
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return Object.fromEntries(Object.entries(value));
};
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
  return value;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
};
export const parseFleetInventory = (value: unknown): AppRegistryEntry[] =>
  array(record(value).apps).map((entry) => {
    const app = record(entry);
    const runtime = app.runtime === undefined ? undefined : record(app.runtime);
    return {
      id: string(app.id),
      name: string(app.name),
      icon: string(app.icon),
      description: string(app.description),
      baseUrl: string(app.baseUrl),
      routes: array(app.routes).map(string),
      ...(runtime ? { runtime: { release: string(runtime.release), syncVersion: string(runtime.syncVersion) } } : {}),
    };
  });
export const parseFleetResources = (value: unknown) => {
  const result = record(value);
  const health = record(result.health);
  return {
    health: {
      state: string(health.state),
      connection: string(health.connection),
      pendingResources: number(health.pendingResources),
      driftedResources: number(health.driftedResources),
    },
    resources: array(result.resources).map((entry) => {
      const resource = record(entry);
      return {
        namespace: string(resource.namespace),
        kind: string(resource.kind),
        id: string(resource.id),
        owner: string(resource.owner),
        state: string(resource.state),
        ...(resource.detail === undefined ? {} : { detail: record(resource.detail) }),
      };
    }),
  };
};
export type FleetResourceReport = { appId: string; result: ReturnType<typeof parseFleetResources> | null; error?: string };

export const findReleaseMismatches = (apps: readonly AppRegistryEntry[], expectedRelease: string): string[] =>
  apps.filter((app) => app.runtime?.release !== expectedRelease).map((app) => `${app.id}=${app.runtime?.release ?? "unknown"}`);

export const assessFleetState = (input: {
  apps: readonly AppRegistryEntry[];
  reports: readonly FleetResourceReport[];
  expectedAppIds: readonly string[];
  expectedRelease?: string;
  expectedNamespace: string;
}): string[] => {
  const failures: string[] = [];
  const apps = new Set(input.apps.map((app) => app.id));
  if (apps.size === 0) failures.push("Core reports no registered apps.");
  for (const id of input.expectedAppIds) if (!apps.has(id)) failures.push(`Expected app ${id} is missing from the live registry.`);
  failures.push(
    ...assessRuntimeCompatibility(input.apps)
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message),
  );
  for (const app of input.apps) {
    if (app.runtime?.syncVersion !== EXPECTED_SYNC_VERSION) failures.push(`${app.id} does not report @k2b/sync ${EXPECTED_SYNC_VERSION}.`);
    if (!input.reports.some((report) => report.appId === app.id)) failures.push(`${app.id} has no Sync resource report.`);
  }
  if (input.expectedRelease) {
    const mismatches = findReleaseMismatches(input.apps, input.expectedRelease);
    if (mismatches.length) failures.push(`Apps do not report ${input.expectedRelease}: ${mismatches.join(", ")}`);
  }
  for (const report of input.reports) {
    if (!report.result) {
      failures.push(`${report.appId}: ${report.error ?? "Sync resources unavailable"}`);
      continue;
    }
    const { health, resources } = report.result;
    if (health.state !== "ready" || health.connection !== "connected" || health.pendingResources || health.driftedResources) {
      failures.push(
        `${report.appId}: Sync is ${health.state}/${health.connection}, ${health.pendingResources} pending, ${health.driftedResources} drifted resources.`,
      );
    }
    for (const resource of resources) {
      if (resource.state !== "ready") failures.push(`${report.appId}/${resource.kind}/${resource.id}: ${resource.state}.`);
      if (resource.namespace !== input.expectedNamespace)
        failures.push(`${report.appId}/${resource.id}: unexpected namespace ${resource.namespace}.`);
      const deadLetters = resource.detail?.deadLetters;
      if (typeof deadLetters === "number" && deadLetters > 0)
        failures.push(`${report.appId}/${resource.id}: ${deadLetters} dead letters require review.`);
    }
  }
  return failures;
};

const run = async (command: string[]): Promise<string> => {
  const child = Bun.spawn(command, { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stdout.trim();
};

export const readCoreJson = async (origin: URL, path: string, token: string): Promise<unknown> => {
  const response = await fetch(new URL(path, origin), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Core ${path} returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Core ${path} returned no body`);
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error(`Core ${path} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

/** Read-only v6 fleet check. Legacy Redis/Yjs evidence is a separate pre-cutover command. */
export const main = async (): Promise<number> => {
  const expectedTag = process.env.CLOUD_IMAGE_TAG?.trim();
  if (!expectedTag || !/^sha-[0-9a-f]{7,40}$/.test(expectedTag)) {
    console.error("CLOUD_IMAGE_TAG must be an immutable sha-<git-sha> tag.");
    return 1;
  }
  const coreUrl = process.env.CLOUD_CORE_URL?.trim();
  const token = process.env.CLOUD_ADMIN_TOKEN?.trim();
  const namespace = process.env.SYNC_NAMESPACE?.trim();
  if (!coreUrl || !token || !namespace) {
    console.error("CLOUD_CORE_URL, CLOUD_ADMIN_TOKEN and SYNC_NAMESPACE are required for the read-only v6 fleet check.");
    return 1;
  }
  let origin: URL;
  try {
    origin = new URL(coreUrl);
  } catch {
    console.error("CLOUD_CORE_URL must be a valid Core origin.");
    return 1;
  }
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password) {
    console.error("CLOUD_CORE_URL must be an HTTP(S) Core origin without URL credentials.");
    return 1;
  }
  const failures: string[] = [];
  let expectedAppIds: string[] = [];
  console.log(`Expected Cloud release: ${expectedTag}; Sync namespace: ${namespace}`);
  try {
    const images = (await run(["docker", "compose", "-f", COMPOSE_FILE, "config", "--images"])).split(/\r?\n/).filter(Boolean);
    const mismatched = images.filter((image) => !image.endsWith(`:${expectedTag}`));
    if (!images.length) failures.push("Production Compose rendered no runtime images.");
    if (mismatched.length) failures.push(`Compose contains images outside ${expectedTag}: ${mismatched.join(", ")}`);
    expectedAppIds = (await run(["docker", "compose", "-f", COMPOSE_FILE, "config", "--services"]))
      .split(/\r?\n/)
      .filter((name) => name.startsWith("app-"))
      .map((name) => name.slice(4));
    const containerIds = (await run(["docker", "compose", "-f", COMPOSE_FILE, "ps", "-q"])).split(/\r?\n/).filter(Boolean);
    if (containerIds.length) {
      const runningImages = (await run(["docker", "inspect", "--format", "{{.Config.Image}}", ...containerIds]))
        .split(/\r?\n/)
        .filter(Boolean);
      const tags = new Set(runningImages.map((image) => image.slice(image.lastIndexOf(":") + 1)));
      if (tags.size !== 1 || !tags.has(expectedTag)) failures.push(`Running containers do not use ${expectedTag}.`);
      if (tags.size > 1) failures.push(`Running Cloud containers use mixed image tags: ${[...tags].sort().join(", ")}`);
      if ([...tags].some((tag) => tag === "latest" || tag === "main")) failures.push("Running Cloud containers use a mutable image tag.");
      console.log(`Running containers: ${containerIds.length}; image tags: ${[...tags].sort().join(", ")}`);
    } else failures.push("Production Compose has no running containers; live readiness is unverified.");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const apps = parseFleetInventory(await readCoreJson(origin, "/api/admin/sync", token));
    const reports: FleetResourceReport[] = [];
    // Serial requests bound load even when the fleet is large.
    for (const app of apps) {
      try {
        const result = parseFleetResources(await readCoreJson(origin, `/api/admin/sync/${encodeURIComponent(app.id)}/resources`, token));
        reports.push({ appId: app.id, result });
        console.log(
          `${app.id}: release ${app.runtime?.release ?? "unknown"}, @k2b/sync ${app.runtime?.syncVersion ?? "unknown"}, ${result.resources.length} resources, ${result.health.state}`,
        );
      } catch (error) {
        reports.push({ appId: app.id, result: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    failures.push(
      ...assessFleetState({
        apps,
        reports,
        expectedAppIds,
        expectedRelease: expectedTag,
        expectedNamespace: namespace,
      }),
    );
  } catch (error) {
    failures.push(`Fleet preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length) {
    console.error("Preflight blocked:");
    for (const failure of failures) console.error(`- ${failure}`);
    console.error("Resolve the reported failures before upgrading. This command never changes Redis, NATS resources, or containers.");
    return 1;
  }
  console.log("v6 fleet preflight passed. Legacy drain and Yjs snapshot evidence remain separate cutover requirements.");
  return 0;
};
if (import.meta.main) process.exitCode = await main();
