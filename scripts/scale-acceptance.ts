#!/usr/bin/env bun
/** Cross-replica acceptance against an isolated, disposable production Compose stack. */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
// Reuse Notebooks' installed Yjs dependency; this harness adds no package dependency.
import * as Y from "../packages/notebooks/node_modules/yjs";
import type { SmtpSinkMessage } from "./fixtures/smtp-sink";
import { dotenvLeak } from "./fixtures/test-infra-env";
import { runUnderHeavyLock } from "./heavy-lock";
import { appIds, devServiceName, imageName, workspaceRoot } from "./workspace";

export const SCALED_APPS = ["core", "mail", "chat", "notebooks"] as const;
type App = (typeof SCALED_APPS)[number];
const APPS = ["gateway", ...SCALED_APPS];
const HOST = "cloud.scale-acceptance.test";
const ORIGIN = `https://${HOST}`;
export const HELP = `Usage: bun --no-env-file scripts/scale-acceptance.ts [options]

Boot a disposable Compose project with two Core, Mail, Chat and Notebooks replicas.
Requires Docker and installed workspace dependencies. Build @k2b/ui first:
  bun run --cwd packages/ui build

  --image-tag <tag>  Use existing ghcr.io/k2b-dev images (pull if missing), instead of building.
  --replicas <n>     1 or 2 (default 2). With 1, the final cross-replica guard MUST fail.
  --help            Show this help without taking a heavy slot or contacting Docker.

The script takes a machine heavy slot itself. CLOUD_HEAVY_SLOTS controls available slots.
Chat stop and surge add at least 140 seconds. SIGKILL recovery can take eight minutes. Containers, volumes and built tags are always removed.
`;
export const parseOptions = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: { help: { type: "boolean" }, "image-tag": { type: "string" }, replicas: { type: "string", default: "2" } },
    strict: true,
    allowPositionals: false,
  });
  check(values.replicas === "1" || values.replicas === "2", "--replicas must be 1 or 2");
  const imageTag = values["image-tag"];
  check(imageTag === undefined || /^[\w][\w.-]{0,127}$/.test(imageTag), "--image-tag must be a Docker image tag");
  return { help: values.help ?? false, imageTag, replicas: Number(values.replicas) };
};

/** Only Docker's client configuration crosses the child boundary, never Compose interpolation. */
export const dockerEnvironment = (inherited: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]) {
    const value = inherited[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/** Complete, fresh interpolation input. No values are read from the caller's environment. */
export const composeEnvironment = (imageTag: string, run: string): Record<string, string> => ({
  CLOUD_IMAGE_TAG: imageTag,
  CLOUD_HOST: HOST,
  POSTGRES_USER: "scale",
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  POSTGRES_DB: `scale_${run}_test`,
  APP_SECRET: randomBytes(32).toString("hex"),
  CLOUD_OAUTH_BROKER_SECRET: randomBytes(32).toString("hex"),
  CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  ADMIN_LOGIN_TOKEN: randomBytes(32).toString("hex"),
  SYNC_NAMESPACE: `scale-${run}`,
  OUTGOING_MAIL_ALLOWED_TARGETS: "sinks",
  NATS_CREDS_FILE: "",
  NATS_TLS_CA_FILE: "",
  GATEWAY_TRUSTED_PROXIES: "",
  GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS: "",
  NATS_ADMIN_SERVERS: "",
  NATS_ADMIN_CREDS_FILE: "",
  NATS_ADMIN_NKEY_SEED_FILE: "",
  NATS_ADMIN_TLS_CA_FILE: "",
  CLOUD_IDENTITY_NEXT_KEY: "",
  CLOUD_IDENTITY_PREVIOUS_KEY: "",
  CLOUD_MAIL_APP_CREDENTIAL: "",
  ASSISTANT_RSQL_ALLOWED_TARGETS: "",
  NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS: "",
  PULSE_SCRAPE_ALLOWED_TARGETS: "",
  GEO_ALLOWED_TARGETS: "",
});
export const envFileContents = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");

export type Replica = { id: string; ip: string; url: string; number: number };
export type ReplicaEvidence = { a: Replica; b: Replica; served: Set<string> };
export const assertBothReplicasServed = (
  app: string,
  evidence: ReplicaEvidence,
  running: Set<string>,
  killed?: string,
  retired: ReadonlySet<string> = new Set(),
) => {
  const { a, b, served } = evidence;
  check(a.id !== b.id, `${app}: replica B is the same container as replica A; the cross-replica run would be vacuous`);
  check(a.ip && b.ip && a.ip !== b.ip, `${app}: replica A and B must have different internal IPs`);
  for (const replica of [a, b]) {
    check(
      running.has(replica.id) || replica.id === killed || retired.has(replica.id),
      `${app}: replica ${replica.number} is no longer running`,
    );
    check(served.has(replica.id), `${app}: replica ${replica.number} served no scenario step`);
  }
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const phase = (name: string, evidence: Record<string, unknown> = {}) => console.log(JSON.stringify({ phase: name, ...evidence }));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Cloud respond() flattens service errors; also accept an explicit error envelope. */
export const mailErrorCode = (body: unknown): string | undefined => {
  if (!record(body)) return undefined;
  if (typeof body.code === "string") return body.code;
  return record(body.error) && typeof body.error.code === "string" ? body.error.code : undefined;
};
type MailAnswer = { status: number; body: unknown };
const succeeded = ({ status }: { status: number }) => status >= 200 && status < 300;
export const mailLeaseBusy = (answer: MailAnswer) => answer.status === 409 && mailErrorCode(answer.body) === "DRAFT_LEASE_BUSY";
/**
 * An unrouted path gets the gateway's exact unmatched-route 502 or Core's exact catch-all answer
 * for that path. Application errors and upstream-unavailable responses never match.
 */
export const registryGapAnswer = (answer: MailAnswer, coreFallthrough: MailAnswer) =>
  (answer.status === 404 && coreFallthrough.status === 404 && JSON.stringify(answer.body) === JSON.stringify(coreFallthrough.body)) ||
  (answer.status === 502 && answer.body === "Bad Gateway — no app registered for this path");

export const mailAttachmentBytes = (length: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 255;
  }
  return bytes;
};

type MailDraftSnapshot = {
  id: string;
  conversationId: string | null;
  revision: number;
  body: string;
  state: string;
  recoveryCopyCount: number;
  attachments: { id: string; filename: string; byteLength: number }[];
};
const mailDraft = (body: unknown): MailDraftSnapshot => {
  check(
    record(body) &&
      typeof body.id === "string" &&
      (body.conversationId === null || typeof body.conversationId === "string") &&
      Number.isInteger(body.revision) &&
      typeof body.revision === "number" &&
      body.revision > 0 &&
      typeof body.body === "string" &&
      typeof body.state === "string" &&
      typeof body.recoveryCopyCount === "number" &&
      Array.isArray(body.attachments),
    `Invalid Mail draft: ${JSON.stringify(body)}`,
  );
  const attachments = body.attachments.map((item: unknown) => {
    check(
      record(item) && typeof item.id === "string" && typeof item.filename === "string" && typeof item.byteLength === "number",
      "Invalid draft attachment",
    );
    return { id: item.id, filename: item.filename, byteLength: item.byteLength };
  });
  return {
    id: body.id,
    conversationId: body.conversationId,
    revision: body.revision,
    body: body.body,
    state: body.state,
    recoveryCopyCount: body.recoveryCopyCount,
    attachments,
  };
};
const mailLease = (body: unknown) => {
  check(
    record(body) &&
      typeof body.token === "string" &&
      typeof body.acquiredAt === "string" &&
      typeof body.expiresAt === "string" &&
      record(body.holder) &&
      typeof body.holder.id === "string",
    `Invalid acquired Mail lease: ${JSON.stringify(body)}`,
  );
  return { token: body.token, acquiredAt: body.acquiredAt, expiresAt: body.expiresAt, holder: { id: body.holder.id } };
};

/** Failed probes are retried only inside this bounded loop; assertions stay outside it. */
const poll = async <T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last = "condition not reached";
  do {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = message(error);
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out after ${timeoutMs} ms: ${last}`);
};

type Inspect = {
  Id: string;
  Name: string;
  RestartCount: number;
  State: { Running: boolean; ExitCode: number; OOMKilled: boolean };
  Config: { Labels: Record<string, string> };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks: Record<string, { IPAddress: string }>;
  };
};
type SinkConnection = { remoteAddress: string; held: boolean; closed: boolean; message?: SmtpSinkMessage };
type MailRow = { id: string; status: string; attempt_count: number; lane: string; app_id: string };

export const run = async (options: ReturnType<typeof parseOptions>) => {
  for (const app of APPS) check(appIds().includes(app), `Unknown workspace app: ${app}`);
  const runId = randomBytes(4).toString("hex");
  const project = `cloud-scale-${runId}`;
  const directory = await mkdtemp(join(tmpdir(), `${project}-`));
  const tag = options.imageTag ?? `scale-${runId}`;
  const env = composeEnvironment(tag, runId);
  const envPath = join(directory, "compose.env");
  const childEnv = dockerEnvironment(process.env);
  const builtTags: string[] = [];
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const sockets = new Set<WebSocket>();
  let database: SQL | undefined;
  let shuttingDown = false;
  let cleanupPromise: Promise<void> | undefined;
  let failure: unknown;
  const docker = async (args: string[], timeoutMs = 60_000, duringCleanup = false): Promise<string> => {
    check(!shuttingDown || duringCleanup, "Scale acceptance is shutting down");
    const child = Bun.spawn(["docker", ...args], { cwd: workspaceRoot, env: childEnv, stdout: "pipe", stderr: "pipe" });
    children.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      check(!timedOut, `docker ${args[0]} timed out after ${timeoutMs} ms`);
      check(code === 0, `docker ${args[0]} failed (${code}): ${stderr.slice(-12_000)}`);
      return (args.includes("logs") ? stdout + stderr : stdout).trim();
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  };
  const composeArgs = [
    "compose",
    "-p",
    project,
    "--project-directory",
    workspaceRoot,
    "--env-file",
    envPath,
    "-f",
    "compose.prod.yml",
    "-f",
    "compose.scale-test.yml",
    // Chat is unreleased in production. Without its profile, `down` and `logs` would skip its containers.
    "--profile",
    "unreleased",
  ];
  const compose = (args: string[], timeoutMs = 240_000) => docker([...composeArgs, ...args], timeoutMs);
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    shuttingDown = true;
    cleanupPromise = (async () => {
      const errors: string[] = [];
      const pending = [...children];
      for (const child of pending) child.kill("SIGKILL");
      await Promise.all(pending.map((child) => child.exited));
      for (const socket of sockets) socket.close();
      try {
        await database?.close({ timeout: 2 });
      } catch (error) {
        errors.push(message(error));
      }
      try {
        await docker([...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], 180_000, true);
      } catch (error) {
        errors.push(message(error));
      }
      // Compose only removes what its active files and profiles name. Anything else labelled with the project fails the run.
      const label = `label=com.docker.compose.project=${project}`;
      for (const [kind, list, remove] of [
        ["container", ["ps", "-aq", "--filter", label], ["rm", "--force", "--volumes"]],
        ["network", ["network", "ls", "-q", "--filter", label], ["network", "rm"]],
        ["volume", ["volume", "ls", "-q", "--filter", label], ["volume", "rm", "--force"]],
      ] as const) {
        try {
          const left = (await docker([...list], 60_000, true)).split(/\s+/).filter(Boolean);
          if (!left.length) continue;
          errors.push(`${left.length} ${kind}(s) of ${project} survived compose down`);
          await docker([...remove, ...left], 60_000, true);
        } catch (error) {
          errors.push(message(error));
        }
      }
      for (const image of builtTags) {
        try {
          await docker(["image", "rm", image], 60_000, true);
        } catch (error) {
          // A build that failed before tagging left nothing to remove.
          if (!message(error).includes("No such image")) errors.push(message(error));
        }
      }
      await rm(directory, { recursive: true, force: true });
      check(errors.length === 0, `Cleanup incomplete: ${errors.join("; ")}`);
      phase("cleanup", { project });
    })();
    return cleanupPromise;
  };
  const signalHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      void cleanup()
        .catch((error) => console.error(message(error)))
        .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  const inspect = async (ids: string[]): Promise<Inspect[]> => (ids.length ? JSON.parse(await docker(["inspect", ...ids])) : []);
  const port = (container: Inspect, inside: number) => {
    const binding = container.NetworkSettings.Ports[`${inside}/tcp`]?.find((entry) => entry.HostIp === "127.0.0.1");
    check(binding, `No loopback port ${inside} for ${container.Id}`);
    return `http://127.0.0.1:${binding.HostPort}`;
  };
  const containers = async (service: string) => {
    const ids = (await compose(["ps", "--status", "running", "-q", service], 60_000)).split(/\s+/).filter(Boolean);
    return (await inspect(ids)).sort(
      (a, b) =>
        Number(a.Config.Labels["com.docker.compose.container-number"]) - Number(b.Config.Labels["com.docker.compose.container-number"]),
    );
  };
  const evidence = new Map<App, ReplicaEvidence>();
  const retired = new Set<string>();
  // Replicas that replace retired ones; the final guard checks that they still run.
  const replacements: Replica[] = [];
  const stillRunning = async (targets: Replica[], killed?: string, retired: ReadonlySet<string> = new Set()) => {
    const states = await inspect([...new Set(targets.map((replica) => replica.id).filter((id) => !retired.has(id)))]);
    for (const state of states) check(state.State.Running || state.Id === killed, `Target container stopped: ${state.Id}`);
    return new Set(states.filter((state) => state.State.Running).map((state) => state.Id));
  };
  const pair = (app: App) => {
    const value = evidence.get(app);
    check(value, `No replicas resolved for ${app}`);
    return value;
  };
  const served = (app: App, target: Replica) => pair(app).served.add(target.id);
  const http = async (
    base: string,
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    expected?: number | null,
  ): Promise<Response> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (expected !== null && !(expected === undefined ? response.ok : response.status === expected)) {
      throw new Error(
        `${method} ${path}: expected ${expected ?? "2xx"}, got ${response.status}: ${(await response.text()).slice(0, 1500)}`,
      );
    }
    return response;
  };
  // HTTP errors are data here. Network failures still fail the scenario, with the request's ten-second deadline.
  const mailCall = async (target: Replica | string, path: string, token: string, method = "GET", body?: unknown): Promise<MailAnswer> => {
    const response = await http(typeof target === "string" ? target : target.url, path, method, body, token, null);
    const raw = await response.text();
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* Core/gateway fallthroughs and empty release answers are not JSON. */
    }
    if (typeof target !== "string") served("mail", target);
    phase("mail-call", {
      target: typeof target === "string" ? "gateway" : target.id,
      path,
      method,
      status: response.status,
      code: mailErrorCode(value),
    });
    return { status: response.status, body: value };
  };
  const request = async <T>(app: App, target: Replica, path: string, token: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await http(target.url, path, method, body, token);
    const value: T = await response.json();
    served(app, target);
    return value;
  };
  const openSocket = async (app: App, target: Replica, path: string, token: string, receive: (frame: unknown) => void) => {
    // Bun extends the browser constructor with request headers.
    const candidate: unknown = Reflect.construct(WebSocket, [
      target.url.replace("http:", "ws:") + path,
      { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } },
    ]);
    check(candidate instanceof WebSocket, "Bun WebSocket is unavailable");
    const socket = candidate;
    sockets.add(socket);
    let failure: string | undefined;
    socket.onmessage = (event) => {
      try {
        receive(JSON.parse(String(event.data)));
      } catch (error) {
        failure = message(error);
      }
    };
    socket.onerror = () => {
      failure = `${app} websocket failed`;
    };
    try {
      await poll(`${app} websocket open`, async () => {
        check(!failure, failure ?? "Socket failed");
        check(socket.readyState !== WebSocket.CLOSED, `${app} websocket closed`);
        return socket.readyState === WebSocket.OPEN;
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    return {
      socket,
      healthy: () => {
        check(!failure, failure ?? "Socket failed");
        check(socket.readyState === WebSocket.OPEN, `${app} websocket closed`);
      },
      markServed: () => served(app, target),
    };
  };
  try {
    await writeFile(envPath, envFileContents(env), { mode: 0o600 });
    const config: { networks: Record<string, { external?: boolean }> } = JSON.parse(await compose(["config", "--format", "json"], 60_000));
    check(
      Object.values(config.networks).every((network) => !network.external),
      "Scale overlay left an external network",
    );
    phase("preparing", { project, tag, replicas: options.replicas });
    for (const app of APPS) {
      const image = `ghcr.io/k2b-dev/${imageName(app)}:${tag}`;
      if (options.imageTag) {
        try {
          await docker(["image", "inspect", image]);
        } catch {
          await docker(["pull", image], 240_000);
        }
      } else {
        // Register before building so a signal immediately after completion still removes the tag.
        builtTags.push(image);
        phase("building", { app, image });
        await docker(
          [
            "build",
            "--build-arg",
            `APP_ID=${app}`,
            "--build-arg",
            "CLOUD_VERSION=0.0.0-scale",
            "--build-arg",
            `CLOUD_RELEASE=scale-${runId}`,
            "--tag",
            image,
            ".",
          ],
          20 * 60_000,
        );
      }
    }
    const infrastructure = ["postgres", "nats", "valkey", "sinks"];
    // Registries time out now and then on hosted runners; `up` itself does not retry a pull.
    for (let attempt = 1; ; attempt++) {
      try {
        await compose(["pull", "--quiet", ...infrastructure]);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        phase("pull-retry", { attempt, error: message(error) });
      }
    }
    await compose(["up", "-d", "--wait", ...infrastructure]);
    // All Core replicas migrate shared schemas before the other applications start.
    await compose(["up", "-d", "--wait", "--scale", `${devServiceName("core")}=${options.replicas}`, "gateway", devServiceName("core")]);
    const applications = SCALED_APPS.filter((app) => app !== "core");
    await compose([
      "up",
      "-d",
      "--wait",
      "--no-recreate",
      ...applications.flatMap((app) => ["--scale", `${devServiceName(app)}=${options.replicas}`]),
      ...applications.map(devServiceName),
    ]);
    for (const app of SCALED_APPS) {
      const resolved = await containers(devServiceName(app));
      check(resolved.length === options.replicas, `${app}: expected ${options.replicas} running containers, got ${resolved.length}`);
      const replicas = resolved.map((container) => {
        const ip = container.NetworkSettings.Networks[`${project}_cloud-internal`]?.IPAddress;
        check(ip, `${app}: missing internal network IP`);
        return {
          id: container.Id,
          ip,
          url: port(container, 3000),
          number: Number(container.Config.Labels["com.docker.compose.container-number"]),
        };
      });
      const a = replicas[0],
        b = replicas[1] ?? a;
      check(a && b && a.number === 1 && b.number === options.replicas, `${app}: unexpected Compose replica numbering`);
      evidence.set(app, { a, b, served: new Set() });
      for (const replica of replicas)
        await poll(
          `${app} replica ${replica.number} readiness`,
          async () => {
            await http(replica.url, "/_cloud/ready");
            return true;
          },
          180_000,
        );
    }
    const [gatewayContainer] = await containers(devServiceName("gateway"));
    const [sinkContainer] = await containers("sinks");
    const [postgresContainer] = await containers("postgres");
    check(gatewayContainer && sinkContainer && postgresContainer, "Infrastructure container missing");
    const gateway = port(gatewayContainer, 3000),
      sink = port(sinkContainer, 8025);
    for (const app of SCALED_APPS)
      await poll(
        `${app} gateway route`,
        async () => {
          const response = await http(gateway, app === "core" ? "/api/openapi.json" : `/api/${app}/openapi.json`);
          const document: { openapi?: string } = await response.json();
          return Boolean(document.openapi);
        },
        180_000,
      );
    // Inspect again after readiness so setup failures followed by a successful restart cannot pass.
    for (const app of APPS) {
      for (const container of await containers(devServiceName(app))) {
        check(container.RestartCount === 0, `${container.Name}: expected RestartCount 0, got ${container.RestartCount}`);
      }
    }
    phase("ready", { project, replicas: Object.fromEntries([...evidence].map(([app, value]) => [app, { a: value.a, b: value.b }])) });
    const login = async () => {
      const response = await http(gateway, "/api/auth/admin-login", "POST", { token: env.ADMIN_LOGIN_TOKEN });
      const signedIn: { session_token: string; user: { id: string } } = await response.json();
      check(signedIn.session_token && signedIn.user.id, "Admin sign-in returned no session");
      const continued = await fetch(`${gateway}/auth/continue`, {
        headers: { cookie: `session_token=${signedIn.session_token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      if (continued.ok) {
        const version = (await continued.text()).match(/data-legal-version="([a-f0-9]{64})"/)?.[1];
        check(version, "Cannot read data-legal-version from /auth/continue");
        await http(gateway, "/api/auth/legal-consent", "POST", { accepted: true, version }, signedIn.session_token);
      } else check(continued.status === 302 || continued.status === 303, `Unexpected /auth/continue status: ${continued.status}`);
      return signedIn;
    };
    const admin = await login(),
      token = admin.session_token;
    const postgresPort = new URL(port(postgresContainer, 5432)).port;
    database = new SQL(`postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/${env.POSTGRES_DB}`, {
      max: 2,
      connectionTimeout: 5,
      idleTimeout: 5,
      connection: { statement_timeout: "10000" },
    });
    const db = database;
    const errors: string[] = [];
    const scenario = async (name: string, action: () => Promise<void>) => {
      phase(name, { status: "running" });
      try {
        await action();
      } catch (error) {
        errors.push(`${name}: ${message(error)}`);
        phase(name, { status: "failed", error: message(error) });
      }
    };
    await scenario("chat-fanout", async () => {
      const { a, b } = pair("chat");
      const frames: { t?: string; id?: string; data?: { type?: string; message?: { id: string } } }[] = [];
      const reader = await openSocket("chat", b, "/api/chat/live", token, (frame) => {
        check(typeof frame === "object" && frame !== null, "Invalid Chat frame");
        frames.push(frame);
      });
      try {
        const created = await request<{ conversation: { id: string } }>("chat", a, "/api/chat/conversations", token, "POST", {
          name: `Scale ${runId}`,
          members: [],
          allowDuplicate: true,
        });
        const id = created.conversation.id;
        reader.socket.send(JSON.stringify({ t: "sub", id: "scale", channel: "conversation", scope: { conversation: id } }));
        await poll("Chat subscription ready on B", async () => {
          reader.healthy();
          return frames.some((frame) => frame.id === "scale" && frame.t === "ready");
        });
        reader.markServed();
        const sent = await request<{ id: string }>("chat", a, `/api/chat/conversations/${id}/messages`, token, "POST", {
          clientId: crypto.randomUUID(),
          body: `scale-${runId}`,
        });
        await poll("Chat message on B", async () => {
          reader.healthy();
          return frames.some(
            (frame) => frame.id === "scale" && frame.t === "event" && frame.data?.type === "message" && frame.data.message?.id === sent.id,
          );
        });
        await stillRunning([a, b]);
        check(
          frames.some(
            (frame) => frame.id === "scale" && frame.t === "event" && frame.data?.type === "message" && frame.data.message?.id === sent.id,
          ),
          "B did not receive the exact Chat message",
        );
        phase("chat-fanout", { status: "passed", messageId: sent.id, writer: a.id, reader: b.id });
      } finally {
        reader.socket.close();
      }
    });
    await scenario("notebooks-fanout", async () => {
      const { a, b } = pair("notebooks");
      const notebook = await request<{ id: string }>("notebooks", a, "/api/notebooks", token, "POST", {
        name: `Scale ${runId}`,
        welcomeNote: false,
      });
      const note = await request<{ id: string }>("notebooks", a, `/api/notebooks/${notebook.id}/notes`, token, "POST", { contentMd: "" });
      const docs = [new Y.Doc(), new Y.Doc()];
      const clients: Awaited<ReturnType<typeof openSocket>>[] = [];
      try {
        for (const [index, replica] of [a, b].entries()) {
          const doc = docs[index];
          check(doc, "Missing Yjs document");
          let ready = false;
          const reader = await openSocket("notebooks", replica, "/api/notebooks/ws", token, (raw) => {
            check(typeof raw === "object" && raw !== null && "type" in raw && "payload" in raw, "Invalid Notebooks frame");
            const payload = raw.payload;
            check(typeof payload === "object" && payload !== null, "Missing Notebooks payload");
            if (raw.type === "notes.yjs.error") throw new Error(`Notebooks rejected client: ${JSON.stringify(payload)}`);
            if (raw.type === "notes.yjs.replay.ready") ready = true;
            if (raw.type === "notes.yjs.sync.push" && "updates" in payload) {
              check(Array.isArray(payload.updates), "Missing Yjs updates");
              for (const update of payload.updates) {
                check(typeof update === "object" && update !== null && typeof update.payload === "string", "Invalid Yjs update");
                Y.applyUpdate(doc, Buffer.from(update.payload, "base64"), "remote");
              }
            }
          });
          clients.push(reader);
          reader.socket.send(JSON.stringify({ type: "notes.yjs.replay.request", payload: { noteId: note.id, fromCursor: null } }));
          await poll(`Notebooks replica ${replica.number} replay ready`, async () => {
            reader.healthy();
            return ready;
          });
          reader.markServed();
        }
        const [docA, docB] = docs,
          writer = clients[0];
        check(docA && docB && writer, "Missing Yjs clients");
        const marker = `scale-yjs-${runId}`;
        const state = Y.encodeStateVector(docA);
        docA.getText("codemirror").insert(docA.getText("codemirror").length, marker);
        writer.socket.send(
          JSON.stringify({
            type: "notes.yjs.sync.publish",
            payload: { noteId: note.id, payload: Buffer.from(Y.encodeStateAsUpdate(docA, state)).toString("base64") },
          }),
        );
        await poll("Yjs convergence on B", async () => {
          for (const client of clients) client.healthy();
          return docB.getText("codemirror").toString().includes(marker);
        });
        await stillRunning([a, b]);
        check(docB.getText("codemirror").toString() === docA.getText("codemirror").toString(), "Yjs documents did not converge");
        phase("notebooks-fanout", { status: "passed", note: note.id, marker, writer: a.id, reader: b.id });
      } finally {
        for (const client of clients) client.socket.close();
      }
    });
    const { a: coreA, b: coreB } = pair("core");
    await request("core", coreA, "/api/admin/core/outgoing-mail/profiles/scale", token, "PUT", {
      name: "Scale acceptance",
      fromAddress: "scale@example.test",
      fromName: null,
      smtpHost: "sinks",
      smtpPort: 2525,
      smtpSecure: false,
      smtpUser: null,
      smtpPassword: null,
      pacePerMinute: 60,
      dailyRecipientLimit: null,
      maxAttachmentBytes: 15728640,
    });
    const trigger = async (target: Replica, label: string) => {
      const recipient = `scale-${label}-${runId}@example.test`;
      // Seed only the account; authentication and notification delivery still use the public API.
      await db`INSERT INTO auth.users (uid, provider, profile, mail) VALUES (${`scale-${label}-${runId}`}, 'local', 'user', ${recipient})`;
      await request("core", target, "/api/auth/email-login", token, "POST", { email: recipient, category: "login" });
      return recipient;
    };
    const mailRows = (recipient: string) =>
      db<MailRow[]>`SELECT id, status, attempt_count, lane, app_id FROM outgoing_mail.messages WHERE ${recipient} = ANY(to_addresses)`;
    const sinkMessages = async (recipient: string): Promise<SmtpSinkMessage[]> => {
      const rows: SmtpSinkMessage[] = await (await http(sink, "/messages")).json();
      return rows.filter((row) => row.to.includes(recipient));
    };
    const normalizeIp = (ip: string) => ip.replace(/^::ffff:/, "");
    const coreForPeer = (peer: string) => {
      const core = [coreA, coreB].find((replica) => replica.ip === normalizeIp(peer));
      check(core, `SMTP peer ${peer} is not a Core replica`);
      served("core", core);
      return core;
    };
    const sentOnce = async (recipient: string, attempts: number, timeoutMs: number) => {
      const row = await poll(
        "Durable outgoing mail sent",
        async () => {
          const messages = await sinkMessages(recipient);
          check(messages.length <= 1, `Duplicate SMTP delivery to ${recipient}`);
          const rows = await mailRows(recipient);
          check(rows.length <= 1, `Duplicate durable mail row for ${recipient}`);
          const current = rows[0];
          check(!current || !["failed", "cancelled", "bounced"].includes(current.status), `Outgoing mail ended in ${current?.status}`);
          return current?.status === "sent" ? current : undefined;
        },
        timeoutMs,
      );
      await stillRunning([coreA, coreB], killedCore);
      const accepted = await sinkMessages(recipient);
      check(accepted.length === 1, `Expected exactly one SMTP acceptance, got ${accepted.length}`);
      check(
        row.attempt_count === attempts && row.app_id === "core" && row.lane === "immediate",
        `Expected Core immediate job with attempt_count ${attempts}: ${JSON.stringify(row)}`,
      );
      const delivery = accepted[0];
      check(delivery, "Missing accepted mail");
      return { row, deliveredBy: coreForPeer(delivery.remoteAddress) };
    };
    let killedCore: string | undefined;
    await scenario("durable-mail-once", async () => {
      await http(sink, "/reset", "POST");
      const recipient = await trigger(coreB, "once");
      const result = await sentOnce(recipient, 1, 90_000);
      phase("durable-mail-once", { status: "passed", trigger: "POST /api/auth/email-login", recipient, ...result });
    });
    let mailboxPath = "",
      identityId = "",
      draftPath = "";
    let draft: MailDraftSnapshot | undefined;
    let lease: ReturnType<typeof mailLease> | undefined;
    let composeFailure: string | undefined;
    let busyRetries = 0;
    const expectSuccess = (answer: MailAnswer, label: string) => {
      check(succeeded(answer), `${label}: ${JSON.stringify(answer)}`);
      return answer.body;
    };
    const expectFailure = (answer: MailAnswer, status: number, code: string, label: string) =>
      check(
        answer.status === status && mailErrorCode(answer.body) === code,
        `${label}: expected ${status} ${code}, got ${JSON.stringify(answer)}`,
      );
    // Like the composer, only a transient lease BUSY retries saves/heartbeats: three attempts total.
    const mailBusyCall = async (
      target: Replica | string,
      path: string,
      session: string,
      body: unknown,
      observe?: (answer: MailAnswer, attempt: number) => void,
    ): Promise<MailAnswer> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        let answer: MailAnswer;
        try {
          answer = await mailCall(target, path, session, "PUT", body);
        } catch (error) {
          observe?.({ status: 0, body: { code: "NETWORK_ERROR", message: message(error) } }, attempt);
          throw error;
        }
        observe?.(answer, attempt);
        if (!mailLeaseBusy(answer) || attempt === 3) return answer;
        busyRetries++;
        await Bun.sleep(100);
      }
      throw new Error("Unreachable Mail retry exhaustion");
    };
    const composeScenario = async (name: string, action: () => Promise<Record<string, unknown>>) => {
      await scenario(name, async () => {
        check(!composeFailure, `Mail compose prerequisite failed: ${composeFailure}`);
        const before = busyRetries;
        try {
          const result = await action();
          const { a, b } = pair("mail");
          await stillRunning([a, b]);
          phase(name, { status: "passed", ...result, busyRetries: busyRetries - before });
        } catch (error) {
          composeFailure = `${name}: ${message(error)}`;
          throw error;
        }
      });
    };
    const editing = () => {
      check(draft && lease && draftPath, "Mail compose setup did not create a draft and held lease");
      return { draft, lease };
    };
    const content = (body: string) => ({
      senderIdentityId: identityId,
      to: [{ address: "recipient@example.test" }],
      subject: `Scale ${runId}`,
      body,
      format: "plain",
    });
    const save = async (target: Replica, body: string) => {
      const current = editing().draft;
      const saved = mailDraft(
        expectSuccess(
          await mailBusyCall(target, draftPath, token, {
            expectedRevision: current.revision,
            draft: content(body),
          }),
          "Autosave",
        ),
      );
      check(
        saved.id === current.id && saved.revision === current.revision + 1 && saved.body === body,
        "Autosave lost content or skipped a revision",
      );
      draft = saved;
      return saved;
    };
    const heartbeat = async (target: Replica, session = token, held = editing().lease) => {
      const renewed = mailLease(
        expectSuccess(await mailBusyCall(target, `${draftPath}/lease`, session, { token: held.token }), "Heartbeat"),
      );
      check(
        renewed.token === held.token && renewed.holder.id === held.holder.id && renewed.acquiredAt === held.acquiredAt,
        "Heartbeat changed the lease",
      );
      return renewed;
    };
    await composeScenario("mail-compose-open", async () => {
      const { a, b } = pair("mail");
      const mailbox = await request<{ id: string }>("mail", a, "/api/mail/mailboxes", token, "POST", {
        name: `Scale ${runId}`,
        description: "Disposable compose acceptance",
      });
      mailboxPath = `/api/mail/mailboxes/${mailbox.id}`;
      identityId = randomBytes(3).toString("hex");
      // Only provider verification lacks an inert public API. Seed it atomically, before any draft exists.
      // resolveMailExecution allows actorSend with active health even when sync_enabled is false.
      // Sync/IMAP/command workers fence on sync_enabled. No Drafts folder is seeded: projection jobs
      // stop at resolveRoleFolder, before loadProviderConnectionRuntimeSnapshot could decrypt this sentinel.
      await db.begin(async (tx) => {
        const [mailboxRow] = await tx<{ id: string }[]>`
          UPDATE mail.mailboxes SET sync_enabled = false, health = 'active', health_reason = NULL
          WHERE short_id = ${mailbox.id} RETURNING id
        `;
        check(mailboxRow, "Mailbox setup could not resolve internal ID");
        const [connection] = await tx<{ id: string; secret_revision: number }[]>`
          INSERT INTO mail.provider_connections (
            owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
            smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, authenticated_principal, last_verified_at
          ) VALUES (
            ${mailboxRow.id}::uuid, 'Scale inert provider', 'sender@example.test', 'sender@example.test',
            'imap.scale.invalid', 993, 'implicit', 'smtp.scale.invalid', 587, 'starttls',
            'password', 'scale-inert-never-decrypt', 'sender@example.test', now()
          ) RETURNING id, secret_revision
        `;
        check(connection, "Provider connection setup returned no row");
        const scope = "c".repeat(64);
        const [resource] = await tx<{ id: string }[]>`
          INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
          VALUES (${mailboxRow.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active') RETURNING id
        `;
        check(resource, "Remote resource setup returned no row");
        const [binding] = await tx<{ id: string }[]>`
          INSERT INTO mail.provider_bindings (
            remote_resource_id, connection_id, state, remote_locator, verified_scope_fingerprint, verified_secret_revision, last_verified_at
          ) VALUES (${resource.id}::uuid, ${connection.id}::uuid, 'active', '{}'::jsonb, ${scope}, ${connection.secret_revision}, now())
          RETURNING id
        `;
        check(binding, "Binding setup returned no row");
        const [folder] = await tx<{ id: string }[]>`
          INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
          VALUES (${randomBytes(3).toString("hex")}, ${resource.id}::uuid, 'scale-sent', 'Sent', 'sent', 'current') RETURNING id
        `;
        check(folder, "Sent folder setup returned no row");
        await tx`
          INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at)
          VALUES (${binding.id}::uuid, ${folder.id}::uuid, 'Sent', 1, 1, ARRAY['read', 'insert']::text[], now())
        `;
        const [identity] = await tx<{ id: string }[]>`
          INSERT INTO mail.sender_identities (
            short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status, sent_folder_id
          ) VALUES (${identityId}, ${mailboxRow.id}::uuid, 'Scale', 'Scale', 'sender@example.test', 'disabled', true, 'verified', ${folder.id}::uuid)
          RETURNING id
        `;
        check(identity, "Sender identity setup returned no row");
        await tx`
          INSERT INTO mail.sender_identity_bindings (
            sender_identity_id, binding_id, provider_principal, verified_at, verified_secret_revision, saves_sent_automatically
          ) VALUES (${identity.id}::uuid, ${binding.id}::uuid, 'sender@example.test', now(), ${connection.secret_revision}, false)
        `;
      });
      phase("mail-compose-setup", { mailbox: mailbox.id, create: a.id, syncEnabled: false, provider: "inert .invalid; Sent folder only" });
      draft = mailDraft(
        expectSuccess(await mailCall(gateway, `${mailboxPath}/drafts`, token, "POST", content("Compose opened")), "Gateway draft creation"),
      );
      draftPath = `${mailboxPath}/drafts/${draft.id}`;
      const composerPath = `/app/mail/${mailbox.id}/compose/${draft.id}`;
      const page = await fetch(`${gateway}${composerPath}`, {
        headers: { cookie: `session_token=${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      // Consume the body too, so rendering errors and open response streams cannot be hidden by headers.
      const html = await page.text();
      check(page.status === 200 && html.includes(draft.id), `SSR composer ${composerPath}: ${page.status}`);
      phase("mail-compose-ssr", { via: "gateway", path: composerPath, status: page.status });
      const editorId = crypto.randomUUID();
      lease = mailLease(expectSuccess(await mailCall(a, `${draftPath}/lease`, token, "POST", { editorId }), "Acquire E1 on A"));
      const repeated = mailLease(expectSuccess(await mailCall(b, `${draftPath}/lease`, token, "POST", { editorId }), "Repeat E1 on B"));
      check(
        repeated.token === lease.token && repeated.acquiredAt === lease.acquiredAt && lease.holder.id === admin.user.id,
        "Retried acquire did not return E1's own lease",
      );
      return {
        draft: draft.id,
        revision: draft.revision,
        holder: lease.holder.id,
        acquire: a.id,
        repeatedAcquire: b.id,
        create: "gateway",
      };
    });
    await composeScenario("mail-compose-autosave", async () => {
      const { a, b } = pair("mail");
      for (let index = 0; index < 6; index++) await save(index % 2 === 0 ? a : b, `Autosave ${index + 1} ${runId}`);
      const expected = editing().draft;
      for (const target of [a, b]) {
        const read = mailDraft(expectSuccess(await mailCall(target, draftPath, token), "Read autosaved draft"));
        check(
          read.body === expected.body && read.revision === expected.revision && read.recoveryCopyCount === 0,
          "Replica lost autosave or created a recovery copy",
        );
        const copies = expectSuccess(await mailCall(target, `${draftPath}/recovery-copies`, token), "Recovery copies");
        check(Array.isArray(copies) && copies.length === 0, "Autosaves created a conflict/recovery copy");
      }
      return { saves: 6, alternating: [a.id, b.id], readers: [a.id, b.id], revision: expected.revision, recoveryCopies: 0 };
    });
    await composeScenario("mail-compose-heartbeat", async () => {
      const { a, b } = pair("mail");
      const previous = editing();
      // Ensure a distinct millisecond without depending on scheduler/clock granularity.
      await Bun.sleep(10);
      lease = await heartbeat(b);
      check(Date.parse(lease.expiresAt) > Date.parse(previous.lease.expiresAt), "Heartbeat did not extend expiry");
      const visible = expectSuccess(await mailCall(a, `${draftPath}/lease`, token), "Read lease on A");
      check(
        record(visible) &&
          record(visible.holder) &&
          visible.holder.id === previous.lease.holder.id &&
          visible.acquiredAt === previous.lease.acquiredAt &&
          visible.expiresAt === lease.expiresAt,
        "A did not read B's renewed lease",
      );
      const startRevision = previous.draft.revision;
      for (let round = 0; round < 8; round++) {
        // Settle both requests before ending the scenario even when one assertion fails.
        const results = await Promise.allSettled([save(a, `Concurrent save ${round + 1} ${runId}`), heartbeat(b)]);
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
        }
      }
      check(
        editing().draft.revision === startRevision + 8 && editing().lease.token === previous.lease.token,
        "Concurrent save/heartbeat lost revision or lease",
      );
      return { concurrentRounds: 8, save: a.id, heartbeat: b.id, readLease: a.id, revision: editing().draft.revision };
    });
    await composeScenario("mail-compose-reload", async () => {
      const { a, b } = pair("mail");
      const editorId = crypto.randomUUID();
      const startedAt = Date.now();
      expectFailure(await mailCall(b, `${draftPath}/lease`, token, "POST", { editorId }), 409, "DRAFT_LEASE_HELD", "E2 before old release");
      const t1 = editing().lease.token;
      expectSuccess(await mailCall(a, `${draftPath}/lease`, token, "DELETE", { token: t1 }), "Old page release on A");
      // One attempt, deliberately outside poll: a committed release must be visible immediately.
      const t2 = mailLease(expectSuccess(await mailCall(b, `${draftPath}/lease`, token, "POST", { editorId }), "E2 after release"));
      check(Date.now() - startedAt < 10_000 && t2.token !== t1, "Reload exceeded the client's grace or reused T1");
      expectSuccess(await mailCall(b, `${draftPath}/lease`, token, "DELETE", { token: t2.token }), "E2 release on B");
      const t3 = mailLease(
        expectSuccess(await mailCall(a, `${draftPath}/lease`, token, "POST", { editorId: crypto.randomUUID() }), "E3 after release"),
      );
      check(t3.token !== t2.token, "Second reload reused T2");
      lease = t3;
      return {
        acquireBeforeRelease: b.id,
        releaseFirst: a.id,
        acquireAfterRelease: b.id,
        reverseRelease: b.id,
        reverseAcquire: a.id,
        attemptsAfterRelease: [1, 1],
        graceMs: Date.now() - startedAt,
      };
    });
    await composeScenario("mail-compose-takeover", async () => {
      const { a, b } = pair("mail");
      const current = editing();
      const second = await login();
      check(second.session_token !== token && second.user.id === admin.user.id, "Expected a second session of the same admin");
      const pendingLiveRows = async () => {
        const [row] = await db<{ count: number }[]>`
          SELECT count(*)::int AS count FROM events.outbox WHERE kind = 'live' AND app_id = 'mail'
        `;
        check(row, "Missing Mail live outbox count");
        return row.count;
      };
      // Published rows are deleted: drain setup invalidations onto the topic before subscribing.
      await poll("Mail live outbox drained before subscription", async () => (await pendingLiveRows()) === 0, 15_000);
      const frames: unknown[] = [];
      let ready = false;
      const subscription = "scale-mail-compose";
      const reader = await openSocket("mail", a, "/api/mail/live", token, (frame) => {
        check(record(frame), "Invalid Mail live frame");
        if (frame.id !== subscription) return;
        if (frame.t === "ready") ready = true;
        else if (ready && frame.t === "event") frames.push(frame);
      });
      try {
        const mailboxId = mailboxPath.split("/").at(-1);
        check(mailboxId, "Mailbox scope missing");
        reader.socket.send(JSON.stringify({ t: "sub", id: subscription, channel: "mailbox", scope: { mailbox: mailboxId } }));
        await poll(
          "Mail subscription ready on A",
          async () => {
            reader.healthy();
            return ready;
          },
          10_000,
        );
        reader.markServed();
        expectFailure(
          await mailCall(b, `${draftPath}/lease`, second.session_token, "POST", {}),
          409,
          "DRAFT_LEASE_HELD",
          "Second session plain acquire",
        );
        const held = expectSuccess(await mailCall(b, `${draftPath}/lease`, second.session_token), "Conflict holder on B");
        check(
          record(held) && record(held.holder) && held.holder.id === current.lease.holder.id && held.acquiredAt === current.lease.acquiredAt,
          "B did not name the original holder",
        );
        check((await pendingLiveRows()) === 0, "Mail live outbox gained pending rows before takeover");
        // Discard any frames from setup: only a post-ready, post-acquire event can prove takeover fanout.
        frames.length = 0;
        const taken = mailLease(
          expectSuccess(
            await mailCall(b, `${draftPath}/lease`, second.session_token, "POST", { takeover: true, editorId: crypto.randomUUID() }),
            "Takeover on B",
          ),
        );
        check(taken.token !== current.lease.token, "Takeover reused T3");
        const relevantEvent = () =>
          frames.find(
            (frame) =>
              record(frame) &&
              record(frame.data) &&
              (frame.data.conversationId === null || frame.data.conversationId === current.draft.conversationId),
          );
        await poll(
          "Mail takeover live event on A",
          async () => {
            reader.healthy();
            return relevantEvent();
          },
          10_000,
        );
        expectFailure(
          await mailBusyCall(a, `${draftPath}/lease`, token, { token: current.lease.token }),
          409,
          "DRAFT_LEASE_NOT_OWNED",
          "Old T3 heartbeat",
        );
        await heartbeat(a, second.session_token, taken);
        expectSuccess(await mailCall(a, `${draftPath}/lease`, second.session_token, "DELETE", { token: taken.token }), "Release T4");
        lease = mailLease(
          expectSuccess(await mailCall(b, `${draftPath}/lease`, token, "POST", { editorId: crypto.randomUUID() }), "Reacquire E5"),
        );
        check(lease.token !== taken.token && lease.token !== current.lease.token, "Reacquire reused an old token");
        return {
          holder: held.holder,
          conflictAndTakeover: b.id,
          liveReader: a.id,
          oldAndNewHeartbeat: a.id,
          reacquire: b.id,
          event: relevantEvent(),
        };
      } finally {
        reader.socket.close();
      }
    });
    await composeScenario("mail-compose-attachment", async () => {
      const { a, b } = pair("mail");
      const held = editing().lease;
      const chunkBytes = 1024 * 1024;
      const bytes = mailAttachmentBytes(chunkBytes + 300 * 1024, 0x5ca1e);
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const filename = `scale-${runId}.bin`;
      const upload = expectSuccess(
        await mailCall(a, `${draftPath}/attachment-uploads`, token, "POST", {
          filename,
          contentType: "application/octet-stream",
          byteLength: bytes.byteLength,
        }),
        "Create upload on A",
      );
      check(record(upload) && typeof upload.id === "string" && upload.chunkSize === chunkBytes, "Invalid upload allocation");
      const uploadPath = `${draftPath}/attachment-uploads/${upload.id}`;
      const chunk = async (target: Replica, offset: number, end: number) => {
        const response = await fetch(`${target.url}${uploadPath}?offset=${offset}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/octet-stream" },
          body: bytes.slice(offset, end),
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });
        const body: unknown = await response.json();
        served("mail", target);
        phase("mail-upload-chunk", { target: target.id, offset, status: response.status });
        expectSuccess({ status: response.status, body }, "Upload chunk");
        check(record(body) && body.receivedBytes === end, "Upload chunk did not advance by its exact byte length");
      };
      await chunk(a, 0, chunkBytes);
      const resumed = expectSuccess(await mailCall(b, uploadPath, token), "Resume upload on B");
      check(record(resumed) && resumed.receivedBytes === chunkBytes && resumed.state === "uploading", "B lost the first upload chunk");
      const listed = expectSuccess(await mailCall(b, `${draftPath}/attachment-uploads`, token), "List resumable upload on B");
      check(
        Array.isArray(listed) && listed.some((item: unknown) => record(item) && item.id === upload.id && item.receivedBytes === chunkBytes),
        "B did not list the resumable upload",
      );
      await chunk(b, chunkBytes, bytes.byteLength);
      const previousRevision = editing().draft.revision;
      draft = mailDraft(
        expectSuccess(await mailCall(b, `${uploadPath}/finalize`, token, "POST", { expectedRevision: previousRevision }), "Finalize on B"),
      );
      check(draft.revision === previousRevision + 1, "Finalizing attachment did not increment revision once");
      const read = mailDraft(expectSuccess(await mailCall(a, draftPath, token), "Read attached draft on A"));
      const attachment = read.attachments.find((item) => item.filename === filename);
      check(
        read.revision === draft.revision && attachment?.byteLength === bytes.byteLength && read.attachments.length === 1,
        "A lost the finalized attachment",
      );
      const download = await http(a.url, `${draftPath}/attachments/${attachment.id}`, "GET", undefined, token);
      const downloaded = new Uint8Array(await download.arrayBuffer());
      served("mail", a);
      check(
        downloaded.byteLength === bytes.byteLength && new Bun.CryptoHasher("sha256").update(downloaded).digest("hex") === hash,
        "Downloaded attachment SHA-256 differs",
      );
      await heartbeat(a, token, held);
      return {
        createAndFirstChunk: a.id,
        resumeAndLastChunkAndFinalize: b.id,
        readAndDownload: a.id,
        filename,
        byteLength: bytes.byteLength,
        sha256: hash,
        revision: draft.revision,
      };
    });
    await composeScenario("mail-compose-send", async () => {
      const { a, b } = pair("mail");
      const held = editing().lease;
      const saved = await save(a, `Ready to send ${runId}`);
      const mailbox = expectSuccess(await mailCall(b, mailboxPath, token), "Read inert mailbox health");
      check(
        record(mailbox) && mailbox.health === "active" && mailbox.syncEnabled === false,
        "Inert fixture lost usable mailbox health or enabled sync",
      );
      const review = expectSuccess(
        await mailCall(b, `${draftPath}/safety-review`, token, "POST", { expectedRevision: saved.revision }),
        "Compose safety review",
      );
      check(
        record(review) && Array.isArray(review.warnings) && review.warnings.length === 0 && review.revision === saved.revision,
        "Inert compose fixture unexpectedly needs safety approval",
      );
      // commands.ts commits state='scheduled', then invalidates the lease before answering. Creation
      // only reads credential metadata; the outbox worker waits until scheduledAt before provider work.
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      // Measure from the request start so the age bound includes heartbeat response latency.
      const lastHeartbeatAt = Date.now();
      await heartbeat(a, token, held);
      const command = expectSuccess(
        await mailCall(b, `${mailboxPath}/commands`, token, "POST", {
          kind: "send",
          draftId: saved.id,
          expectedDraftRevision: saved.revision,
          senderIdentityId: identityId,
          idempotencyKey: crypto.randomUUID(),
          scheduledAt,
          undoSeconds: 0,
        }),
        "Schedule send through B",
      );
      check(record(command) && typeof command.id === "string" && command.kind === "send", "Missing send command");
      for (const target of [a, b]) {
        expectFailure(
          await mailBusyCall(target, `${draftPath}/lease`, token, { token: held.token }),
          404,
          "NOT_FOUND",
          "Consumed draft heartbeat",
        );
        expectFailure(await mailCall(target, `${draftPath}/lease`, token), 404, "NOT_FOUND", "Consumed draft lease read");
        const read = mailDraft(expectSuccess(await mailCall(target, draftPath, token), "Read scheduled draft"));
        check(read.state === "scheduled", `Consumed draft remained editable: ${read.state}`);
        draft = read;
      }
      expectFailure(
        await mailCall(a, `${draftPath}/lease`, token, "POST", { editorId: crypto.randomUUID() }),
        404,
        "NOT_FOUND",
        "Acquire consumed draft",
      );
      expectSuccess(await mailCall(a, `${mailboxPath}/commands/${command.id}/cancel`, token, "POST"), "Cancel send on A");
      draft = mailDraft(expectSuccess(await mailCall(b, draftPath, token), "Read restored draft on B"));
      check(
        draft.id === saved.id && draft.state === "draft" && draft.revision === saved.revision + 1,
        "Cancel did not restore the editable draft with one new revision",
      );
      // One attempt, without takeover: an unremoved lease would still answer DRAFT_LEASE_HELD.
      const acquired = await mailCall(a, `${draftPath}/lease`, token, "POST", { editorId: crypto.randomUUID() });
      const msSinceLastHeartbeat = Date.now() - lastHeartbeatAt;
      check(msSinceLastHeartbeat < 20_000, `Reacquire took ${msSinceLastHeartbeat} ms since heartbeat; old lease could have expired`);
      check(acquired.status === 200, `Reacquire after cancel: expected 200, got ${JSON.stringify(acquired)}`);
      const reacquired = mailLease(expectSuccess(acquired, "Reacquire after cancel on A"));
      check(reacquired.token !== held.token, "Reacquire after cancel reused the old token");
      expectFailure(
        await mailBusyCall(b, `${draftPath}/lease`, token, { token: held.token }),
        409,
        "DRAFT_LEASE_NOT_OWNED",
        "Old lease heartbeat after cancel on B",
      );
      expectSuccess(
        await mailCall(b, `${draftPath}/lease`, token, "DELETE", { token: reacquired.token }),
        "Release restored draft lease on B",
      );
      lease = undefined;
      return {
        edit: a.id,
        send: b.id,
        command: command.id,
        scheduledAt,
        cancel: a.id,
        restoredRead: b.id,
        reacquire: a.id,
        msSinceLastHeartbeat,
        release: b.id,
        state: draft?.state,
        revision: draft.revision,
        invalidatedOn: [a.id, b.id],
        leaseResponse: "404 NOT_FOUND",
      };
    });
    await composeScenario("mail-compose-restart", async () => {
      const { a, b } = pair("mail");
      if (options.replicas === 1)
        return { status: "skipped", reason: "Negative control has no surviving Mail replica; final vacuity guard will fail" };
      draft = mailDraft(
        expectSuccess(
          await mailCall(b, `${mailboxPath}/drafts`, token, "POST", content("Before graceful restart")),
          "Create restart draft on B",
        ),
      );
      draftPath = `${mailboxPath}/drafts/${draft.id}`;
      lease = mailLease(
        expectSuccess(await mailCall(b, `${draftPath}/lease`, token, "POST", { editorId: crypto.randomUUID() }), "Acquire E6 on B"),
      );
      const held = lease,
        startRevision = draft.revision;
      // Core owns '/', so an unrouted Mail path falls through to Core. Record Core's own
      // answer for each PUT path; only that exact answer counts as the routing gap, never a Mail error.
      const coreFallthrough = new Map<string, MailAnswer>();
      for (const path of [draftPath, `${draftPath}/lease`]) {
        const response = await http(coreB.url, path, "PUT", {}, token, 404);
        const raw = await response.text();
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* Plain-text fallthroughs stay text. */
        }
        served("core", coreB);
        coreFallthrough.set(path, { status: response.status, body });
      }
      type Sample = {
        via: string;
        method: string;
        status: number;
        code?: string;
        body?: string;
        at: string;
        afterReady: boolean;
        attempt: number;
        registryGap: boolean;
      };
      const samples: Sample[] = [];
      const deadline = Date.now() + 90_000;
      let stop = false,
        readyAt: number | undefined,
        loopError: unknown;
      let saves = 0,
        saveCalls = 0,
        heartbeatCalls = 0,
        nextHeartbeat = Date.now();
      const call = async (target: Replica | string, path: string, body: unknown) => {
        const answer = await mailBusyCall(target, path, token, body, (answer, attempt) => {
          const signature = coreFallthrough.get(path);
          const registryGap = typeof target === "string" && signature !== undefined && registryGapAnswer(answer, signature);
          samples.push({
            via: typeof target === "string" ? "gateway" : target.id,
            method: path.endsWith("/lease") ? "heartbeat" : "autosave",
            status: answer.status,
            code: mailErrorCode(answer.body),
            ...(succeeded(answer) ? {} : { body: JSON.stringify(answer.body).slice(0, 200) }),
            at: new Date().toISOString(),
            afterReady: readyAt !== undefined,
            attempt,
            registryGap,
          });
        });
        expectSuccess(
          answer,
          `Editing during restart via ${typeof target === "string" ? "gateway" : target.id}; samples=${JSON.stringify(samples)}`,
        );
        return answer;
      };
      const editLoop = (async () => {
        try {
          while (!stop && Date.now() < deadline) {
            const tick = Date.now();
            const target = saveCalls++ % 2 === 0 ? gateway : b;
            const body = `Restart autosave ${saveCalls} ${runId}`;
            const expected = editing().draft;
            const pending = [
              call(target, draftPath, { expectedRevision: expected.revision, draft: content(body) }).then((answer) => {
                const saved = mailDraft(answer.body);
                check(
                  saved.id === expected.id && saved.revision === expected.revision + 1 && saved.body === body,
                  "Restart autosave lost a revision or content",
                );
                draft = saved;
                saves++;
              }),
            ];
            if (tick >= nextHeartbeat) {
              nextHeartbeat = tick + 3_000;
              const target = heartbeatCalls++ % 2 === 0 ? gateway : b;
              pending.push(
                call(target, `${draftPath}/lease`, { token: held.token }).then((answer) => {
                  const renewed = mailLease(answer.body);
                  check(renewed.token === held.token && renewed.acquiredAt === held.acquiredAt, "Restart changed T6");
                }),
              );
            }
            const results = await Promise.allSettled(pending);
            for (const result of results) {
              if (result.status === "rejected") throw result.reason;
            }
            await Bun.sleep(Math.min(Math.max(0, 700 - (Date.now() - tick)), Math.max(0, deadline - Date.now())));
          }
          check(stop, "Restart edit loop exceeded its 90-second deadline");
        } catch (error) {
          loopError = error;
        }
      })();
      try {
        await Bun.sleep(3_200);
        check(!loopError, message(loopError));
        phase("mail-compose-restarting", { victim: a.id, survivor: b.id, deadlineMs: 90_000 });
        await docker(["restart", "--time", "30", a.id], 45_000);
        const [restarted] = await inspect([a.id]);
        check(restarted?.Id === a.id && restarted.State.Running, "Graceful restart replaced or stopped A");
        // Docker may reallocate published ports. Mutate the evidence object before probing A again.
        a.url = port(restarted, 3000);
        const ip = restarted.NetworkSettings.Networks[`${project}_cloud-internal`]?.IPAddress;
        check(ip, "Restarted Mail A has no internal IP");
        a.ip = ip;
        phase("mail-compose-restarted-port", { target: a.id, url: a.url });
        await poll(
          "Mail A ready after graceful restart",
          async () => {
            await http(a.url, "/_cloud/ready");
            return true;
          },
          Math.max(1, Math.min(30_000, deadline - Date.now() - 5_000)),
        );
        readyAt = Date.now();
        await Bun.sleep(5_000);
      } finally {
        stop = true;
        await editLoop;
        phase("mail-compose-restart-requests", {
          victim: a.id,
          survivor: b.id,
          samples,
          registryGapCount: samples.filter((sample) => sample.registryGap).length,
          gatewayFailuresAfterReady: samples.filter((sample) => sample.via === "gateway" && sample.afterReady && !succeeded(sample)).length,
        });
      }
      check(!loopError, `Restart editing failed: ${message(loopError)}; samples=${JSON.stringify(samples)}`);
      const final = editing().draft;
      check(final.revision === startRevision + saves && saves > 0, "Restart lost a successful save");
      for (const method of ["autosave", "heartbeat"]) {
        check(
          samples.some((sample) => sample.via === b.id && sample.method === method && sample.status >= 200 && sample.status < 300),
          `No pinned-B ${method} succeeded`,
        );
        check(
          samples.some((sample) => sample.via === "gateway" && sample.method === method),
          `No gateway ${method} attempted`,
        );
      }
      check(
        samples.some((sample) => sample.via === "gateway" && sample.afterReady),
        "No gateway request attempted after A was ready",
      );
      await heartbeat(a, token, held);
      const read = mailDraft(expectSuccess(await mailCall(a, draftPath, token), "Restarted A reads final save"));
      check(read.body === final.body && read.revision === final.revision, "Restarted A lost B/gateway's final body or revision");
      expectSuccess(await mailCall(b, `${draftPath}/lease`, token, "DELETE", { token: held.token }), "Release restart draft");
      return {
        victim: a.id,
        survivor: b.id,
        saves,
        revision: final.revision,
        readyAt: new Date(readyAt ?? 0).toISOString(),
        registryGapCount: samples.filter((sample) => sample.registryGap).length,
        gatewayFailuresAfterReady: samples.filter((sample) => sample.via === "gateway" && sample.afterReady && !succeeded(sample)).length,
      };
    });
    await scenario("chat-replica-stop", async () => {
      if (options.replicas === 1) {
        phase("chat-replica-stop", { status: "skipped", reason: "A graceful stop needs a surviving Chat replica" });
        return;
      }
      const { a, b } = pair("chat");
      await stillRunning([a, b]);
      const path = "/api/chat/conversations";
      const coreResponse = await http(coreB.url, path, "GET", undefined, token, 404);
      const raw = await coreResponse.text();
      let coreBody: unknown = raw;
      try {
        coreBody = JSON.parse(raw);
      } catch {
        /* Core can answer plain text. */
      }
      const coreFallthrough = { status: coreResponse.status, body: coreBody };
      served("core", coreB);
      type Sample = { at: number; completedAt: number; phase: string; status: number | null; body?: unknown; error?: string };
      const samples: Sample[] = [];
      const windows: { phase: string; start: number; completed?: number; exitState?: Inspect["State"] }[] = [];
      let currentPhase = "before-stop",
        stop = false;
      const sample = async () => {
        const at = Date.now(),
          requestPhase = currentPhase;
        try {
          const response = await http(gateway, path, "GET", undefined, token, null);
          const raw = await response.text();
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            /* Routing errors are plain text. */
          }
          samples.push({ at, completedAt: Date.now(), phase: requestPhase, status: response.status, ...(response.ok ? {} : { body }) });
        } catch (error) {
          samples.push({ at, completedAt: Date.now(), phase: requestPhase, status: null, error: message(error) });
        }
      };
      await sample();
      check(samples[0] && samples[0].status !== null && succeeded({ status: samples[0].status }), "Chat gateway route failed before stop");
      const loop = (async () => {
        while (!stop) {
          const tick = Date.now();
          await sample();
          await Bun.sleep(Math.max(0, 250 - (Date.now() - tick)));
        }
      })();
      const retire = async (replica: Replica, name: string) => {
        currentPhase = name;
        const window: { phase: string; start: number; completed?: number; exitState?: Inspect["State"] } = {
          phase: name,
          start: Date.now(),
        };
        windows.push(window);
        await docker(["stop", "--time", "30", replica.id], 45_000);
        const completedAt = Date.now();
        window.completed = completedAt;
        const state = (await inspect([replica.id]))[0]?.State;
        window.exitState = state;
        check(
          state?.Running === false && state.ExitCode === 0 && state.OOMKilled === false,
          `${name}: Chat replica ${replica.id} did not stop gracefully: ${JSON.stringify(state)}`,
        );
        await docker(["rm", replica.id], 30_000);
        retired.add(replica.id);
        // Keep observing past a complete 60-second registry refresh interval.
        await poll(`${name} observation window`, async () => Date.now() >= completedAt + 70_000, 75_000);
      };
      try {
        await retire(a, "original-stop");
        currentPhase = "surge-start";
        const service = devServiceName("chat");
        await compose(["up", "-d", "--wait", "--no-recreate", "--scale", `${service}=3`, service], 240_000);
        const resolved = await containers(service);
        check(resolved.length === 3 && resolved.some((container) => container.Id === b.id), "Chat surge must keep B and add two replicas");
        const surge = resolved.map((container) => ({
          id: container.Id,
          ip: container.NetworkSettings.Networks[`${project}_cloud-internal`]?.IPAddress ?? "",
          url: port(container, 3000),
          number: Number(container.Config.Labels["com.docker.compose.container-number"]),
        }));
        for (const replica of surge) {
          await poll(
            `Surge Chat ${replica.number} readiness`,
            async () => {
              await http(replica.url, "/_cloud/ready");
              return true;
            },
            180_000,
          );
        }
        // As at startup: a surge replica that failed setup and restarted must not pass.
        for (const container of await inspect(surge.map((replica) => replica.id)))
          check(container.RestartCount === 0, `${container.Name}: expected RestartCount 0 after surge, got ${container.RestartCount}`);
        replacements.push(...surge.filter((replica) => replica.id !== b.id));
        phase("chat-replica-stop-surge", { original: b.id, replacements });
        await retire(b, "surge-stop");
        await stillRunning(surge, undefined, retired);
      } finally {
        stop = true;
        await loop;
        const registryGaps = samples.filter(
          (sample) => sample.status !== null && registryGapAnswer({ status: sample.status, body: sample.body }, coreFallthrough),
        );
        const p4InFlight = samples.filter(
          (sample) =>
            (sample.status === null || (sample.status === 502 && sample.body === "Bad Gateway — upstream unavailable")) &&
            windows.some(
              (window) =>
                window.completed !== undefined && sample.completedAt >= window.start && sample.completedAt <= window.completed + 5_000,
            ),
        );
        const p4 = new Set(p4InFlight);
        const failures = samples.filter((sample) => (sample.status === null || !succeeded({ status: sample.status })) && !p4.has(sample));
        phase("chat-replica-stop", {
          samples,
          windows,
          coreFallthrough,
          retired: [...retired],
          registryGapCount: registryGaps.length,
          p4InFlight: p4InFlight.length,
          phases: windows.map((window) => ({
            ...window,
            p4InFlight: p4InFlight.filter(
              (sample) =>
                window.completed !== undefined && sample.completedAt >= window.start && sample.completedAt <= window.completed + 5_000,
            ).length,
          })),
          failures,
        });
        check(registryGaps.length === 0, `Chat had ${registryGaps.length} registry gaps`);
        check(failures.length === 0, `Chat had ${failures.length} failures outside RISK P4: ${JSON.stringify(failures)}`);
      }
    });
    // Run last: the intentionally killed replica must not invalidate earlier scenario checks.
    await scenario("sigkill-mail-recovery", async () => {
      if (options.replicas === 1) {
        phase("sigkill-mail-recovery", {
          status: "skipped",
          reason: "Negative control has no surviving Core replica; final vacuity guard will fail",
        });
        return;
      }
      await stillRunning([coreA, coreB]);
      await http(sink, "/reset", "POST");
      await http(sink, "/hold", "POST");
      try {
        const recipient = await trigger(coreA, "recovery");
        const held = await poll(
          "SMTP held at end of DATA",
          async () => {
            const connections: SinkConnection[] = await (await http(sink, "/connections")).json();
            return connections.find((connection) => connection.held && !connection.closed && connection.message?.to.includes(recipient));
          },
          90_000,
        );
        const victim = coreForPeer(held.remoteAddress),
          survivor = victim.id === coreA.id ? coreB : coreA;
        await stillRunning([victim, survivor]);
        const [sending] = await mailRows(recipient);
        check(sending?.status === "sending" && sending.attempt_count === 1, "Held mail is not on its first durable sending attempt");
        check((await sinkMessages(recipient)).length === 0, "Held DATA was already accepted");
        await docker(["update", "--restart=no", victim.id]);
        await docker(["kill", "--signal", "KILL", victim.id]);
        killedCore = victim.id;
        await http(sink, "/release", "POST");
        phase("sigkill-mail-recovery", {
          status: "waiting",
          victim: victim.id,
          survivor: survivor.id,
          deadlineMs: 8 * 60_000,
          reason: "Core recovers sending rows after five minutes, scanning every 30 seconds",
        });
        const result = await sentOnce(recipient, 2, 8 * 60_000);
        await stillRunning([survivor]);
        check(result.deliveredBy.id === survivor.id, "Recovery did not deliver from the other Core replica");
        const [dead] = await inspect([victim.id]);
        check(dead && !dead.State.Running, "Killed Core restarted; recovery proof is invalid");
        phase("sigkill-mail-recovery", { status: "passed", recipient, victim: victim.id, ...result });
      } finally {
        await http(sink, "/release", "POST");
      }
    });
    for (const app of SCALED_APPS) {
      const current = pair(app);
      const running = await stillRunning([current.a, current.b], killedCore, retired);
      assertBothReplicasServed(devServiceName(app), current, running, killedCore, retired);
    }
    await stillRunning(replacements);
    check(errors.length === 0, errors.join("\n"));
    phase("passed", { project, bothReplicasServed: Object.fromEntries([...evidence].map(([app, value]) => [app, [...value.served]])) });
  } catch (error) {
    // Compose logs prefixes identify every replica, including the deliberately stopped one.
    try {
      console.error(await compose(["logs", "--no-color", "--tail", "200"], 60_000));
    } catch (logsError) {
      console.error(`Cannot collect logs: ${message(logsError)}`);
    }
    failure = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      // Keep the original failure as the result; a cleanup problem is still reported.
      if (failure === undefined) throw error;
      console.error(message(error));
    } finally {
      for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
    }
  }
};

if (import.meta.main) {
  try {
    const options = parseOptions(Bun.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const leak = dotenvLeak(process.cwd(), process.execArgv);
      check(!leak, `Refusing dotenv input (${leak}). Run bun --no-env-file scripts/scale-acceptance.ts`);
      runUnderHeavyLock();
      await run(options);
    }
  } catch (error) {
    phase("failed", { error: message(error) });
    process.exitCode = 1;
  }
}
