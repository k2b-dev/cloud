import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const repository = resolve(import.meta.dir, "../..");
export const buildRoot = join(repository, ".local/perf-baseline/build");
export const caddyImage = "caddy:2.10.2-alpine";

export function measurementOrigin(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3000) throw new Error("Invalid measurement port");
  return `https://localhost:${port}`;
}

/** Skip certificate verification only for this run's exact local HTTPS origin. Callers refuse redirects. */
export function localTls(url: string | URL, origin: string) {
  const local = new URL(origin);
  if (local.hostname !== "localhost" || local.protocol !== "https:" || new URL(url).origin !== local.origin) return {};
  return { tls: { rejectUnauthorized: false } };
}

export function renderCaddyfile(port: number) {
  return `{
  admin off
  auto_https disable_redirects
}

${measurementOrigin(port)} {
  tls internal
  reverse_proxy gateway:3000
}
`;
}

export function browserServer(version: string, port: number) {
  return {
    image: `mcr.microsoft.com/playwright:v${version}-noble`,
    args: ["--init", "--ipc=host", "--user", "pwuser", "--workdir", "/home/pwuser"],
    tail: ["npx", "-y", `playwright@${version}`, "run-server", "--port", String(port), "--host", "0.0.0.0"],
    endpoint: `ws://127.0.0.1:${port}/`,
  };
}

/** Prevent --out and build replacement from escaping this checkout, including existing symlinks. */
export async function worktreePath(path: string): Promise<string> {
  const target = resolve(repository, path);
  const within = (candidate: string) => {
    const part = relative(repository, candidate);
    return part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part);
  };
  if (!within(target)) throw new Error("Output must stay inside this worktree");
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, "..");
  if (!within(await realpath(ancestor))) throw new Error("Output symlink leaves this worktree");
  return target;
}

export async function command(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
    includeStderr?: boolean;
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? repository,
    env: options.env ?? Bun.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
    timeout: options.timeoutMs ?? 60_000,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  options.signal?.throwIfAborted();
  if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} exited ${code}: ${stderr.trim() || stdout.trim()}`);
  return options.includeStderr ? [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") : stdout.trim();
}

export function runtimeImage(dockerfile: string) {
  const image = /^FROM\s+(\S+)\s+AS\s+runtime\s*$/im.exec(dockerfile)?.[1];
  if (!image || !/^oven\/bun:[^\s]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Dockerfile runtime stage must pin the Bun image digest");
  return image;
}

/** Cover image-declared VOLUME paths too, so Docker cannot create unprefixed anonymous volumes. */
export function unmountedVolumes(declared: string[], args: string[]) {
  const mounted = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--volume") continue;
    const spec = args[++i];
    if (!spec) throw new Error("Missing Docker volume specification");
    mounted.add(spec.split(":")[1] ?? spec);
  }
  return declared.filter((path) => !mounted.has(path)).sort();
}

export async function freeLoopbackPort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolvePort, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("No free loopback port"));
        return;
      }
      listener.close((error) =>
        error ? reject(error) : address.port === 3000 ? freeLoopbackPort().then(resolvePort, reject) : resolvePort(address.port),
      );
    });
  });
}

export async function waitFor(label: string, probe: () => Promise<boolean>, signal: AbortSignal, timeoutMs = 180_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    if (await probe().catch(() => false)) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Readiness timeout (${timeoutMs} ms): ${label}`);
}

export class Runtime {
  readonly prefix = `cloud-perf-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  readonly directory = join(repository, ".local/perf-baseline", this.prefix);
  readonly containers: string[] = [];
  readonly volumes: string[] = [];
  readonly networks: string[] = [];
  private browserPort: number | null = null;
  readonly adminToken = crypto.randomUUID();
  readonly filegateToken = crypto.randomUUID();
  private readonly appSecret = crypto.randomUUID();
  readonly origin: string;
  constructor(
    readonly port: number,
    readonly image: string,
    readonly signal: AbortSignal,
  ) {
    this.origin = measurementOrigin(port);
  }

  name(service: string) {
    return `${this.prefix}-${service}`;
  }

  private async owns(kind: "container" | "volume" | "network", name: string) {
    const format = kind === "container" ? '{{index .Config.Labels "cloud.perf.run"}}' : '{{index .Labels "cloud.perf.run"}}';
    return (await command(["docker", kind, "inspect", "--format", format, name], { timeoutMs: 5000, signal: this.signal })) === this.prefix;
  }

  async build(apps: string[], skip: boolean) {
    await worktreePath(buildRoot);
    if (!skip && existsSync(join(repository, "dist")))
      throw new Error("Root dist already exists; move it aside inside this worktree before building (the production builder replaces it)");
    const env = {
      PATH: Bun.env.PATH,
      HOME: Bun.env.HOME,
      NODE_ENV: "production",
      CLOUD_VERSION: "0.0.0-perf",
      CLOUD_RELEASE: "perf",
      BUN_OPTIONS: "--no-env-file",
      TMPDIR: join(this.directory, "tmp"),
    };
    if (!skip) {
      console.log("Building production @k2b/ui…");
      await command(["bun", "run", "--cwd", "packages/ui", "build"], { env, timeoutMs: 600_000, signal: this.signal });
    }
    for (const id of apps) {
      const destination = await worktreePath(join(buildRoot, id, "dist"));
      if (skip) {
        if (!existsSync(join(destination, "server.js"))) throw new Error(`--skip-build missing ${destination}/server.js`);
        continue;
      }
      this.signal.throwIfAborted();
      console.log(`Building production ${id}…`);
      const started = performance.now();
      const progress = setInterval(() => console.log(`Building ${id}: ${Math.round((performance.now() - started) / 1000)} s`), 30_000);
      try {
        await command(["bun", "run", "packages/cloud/scripts/build.ts"], {
          env: { ...env, APP_ID: id, APP_DIR: join(repository, "packages", id) },
          timeoutMs: 600_000,
          signal: this.signal,
        });
        await mkdir(resolve(destination, ".."), { recursive: true });
        await rm(destination, { recursive: true, force: true });
        await rename(join(repository, "dist"), destination);
      } finally {
        clearInterval(progress);
      }
    }
  }

  private async volume(service: string) {
    const name = this.name(service);
    this.volumes.push(name);
    await command(["docker", "volume", "create", "--label", `cloud.perf.run=${this.prefix}`, name], { signal: this.signal });
    if (!(await this.owns("volume", name))) throw new Error(`Could not establish volume ownership: ${name}`);
    return name;
  }

  async container(
    service: string,
    image: string,
    args: string[] = [],
    tail: string[] = [],
    env?: Record<string, string>,
    network: "run" | "host" | `container:${string}` = "run",
  ) {
    this.signal.throwIfAborted();
    const inspectImage = () =>
      command(["docker", "image", "inspect", "--format", "{{json .Config.Volumes}}", image], { timeoutMs: 5000, signal: this.signal });
    let imageVolumes: string;
    try {
      imageVolumes = await inspectImage();
    } catch {
      console.log(`Pulling ${image}…`);
      await command(["docker", "pull", image], { timeoutMs: 120_000, signal: this.signal });
      imageVolumes = await inspectImage();
    }
    const declared = z.record(z.string(), z.unknown()).nullable().parse(JSON.parse(imageVolumes));
    const volumes: string[] = [];
    for (const [index, path] of unmountedVolumes(Object.keys(declared ?? {}), args).entries())
      volumes.push("--volume", `${await this.volume(`${service}-volume-${index}`)}:${path}`);
    const envArgs: string[] = [];
    if (env) {
      const path = join(this.directory, `${service}.env`);
      await writeFile(
        path,
        Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        { mode: 0o600 },
      );
      envArgs.push("--env-file", path);
    }
    const name = this.name(service);
    // Track the attempt before Docker can create anything, even if the command is aborted.
    this.containers.push(name);
    await command(
      [
        "docker",
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `cloud.perf.run=${this.prefix}`,
        "--network",
        network === "run" ? this.prefix : network,
        ...(network === "run" ? ["--network-alias", service] : []),
        "--log-opt",
        "max-size=4m",
        ...envArgs,
        ...args,
        ...volumes,
        image,
        ...tail,
      ],
      { timeoutMs: 120_000, signal: this.signal },
    );
    if (!(await this.owns("container", name))) throw new Error(`Could not establish container ownership: ${name}`);
  }

  async start(apps: string[]) {
    await mkdir(join(this.directory, "tmp"), { recursive: true });
    this.networks.push(this.prefix);
    await command(["docker", "network", "create", "--label", `cloud.perf.run=${this.prefix}`, this.prefix], { signal: this.signal });
    if (!(await this.owns("network", this.prefix))) throw new Error(`Could not establish network ownership: ${this.prefix}`);
    await this.container(
      "postgres",
      "postgres:17-alpine",
      ["--volume", `${await this.volume("postgres-data")}:/var/lib/postgresql/data`],
      [],
      { POSTGRES_USER: "ipa", POSTGRES_PASSWORD: "ipa", POSTGRES_DB: "cloud_perf_test" },
    );
    await this.container(
      "nats",
      "nats:2.14.3-alpine",
      ["--volume", `${join(repository, ".github/nats-ci.conf")}:/etc/nats.conf:ro`, "--volume", `${await this.volume("nats-data")}:/data`],
      ["--config", "/etc/nats.conf"],
    );
    await this.container("valkey", "valkey/valkey:8-alpine", [], ["valkey-server", "--save", "", "--appendonly", "no"]);
    await waitFor(
      "PostgreSQL",
      async () => {
        await command(["docker", "exec", this.name("postgres"), "pg_isready", "-U", "ipa", "-d", "cloud_perf_test"], {
          timeoutMs: 5000,
          signal: this.signal,
        });
        return true;
      },
      this.signal,
      60_000,
    );
    for (const id of apps) {
      console.log(`Starting ${id}…`);
      const env: Record<string, string> = {
        NODE_ENV: "production",
        APP_ID: id,
        CLOUD_VERSION: "0.0.0-perf",
        CLOUD_RELEASE: "perf",
        DATABASE_URL: "postgresql://ipa:ipa@postgres:5432/cloud_perf_test",
        REDIS_URL: "redis://valkey:6379",
        NATS_SERVERS: "nats://nats:4222",
        SYNC_REPLICAS: "1",
        SYNC_NAMESPACE: this.prefix,
        APP_URL: this.origin,
        APP_SECRET: this.appSecret,
        CLOUD_IDENTITY_JWKS_ORIGIN: "http://app-core:3000",
        CLOUD_CORE_INTERNAL_ORIGIN: "http://app-core:3000",
      };
      if (id === "core")
        Object.assign(env, {
          ADMIN_LOGIN_TOKEN: this.adminToken,
          CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
          CLOUD_OAUTH_BROKER_SECRET: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
        });
      await this.container(
        id === "gateway" ? "gateway" : `app-${id}`,
        this.image,
        ["--user", "bun", "--workdir", "/app", "--volume", `${join(buildRoot, id, "dist")}:/app:ro`],
        ["bun", "server.js"],
        env,
      );
      if (id !== "gateway")
        await waitFor(
          id,
          async () => {
            await command(
              [
                "docker",
                "exec",
                this.name(`app-${id}`),
                "bun",
                "-e",
                'const r=await fetch("http://127.0.0.1:3000/_cloud/ready");if(!r.ok)process.exit(1)',
              ],
              { timeoutMs: 8000, signal: this.signal },
            );
            return true;
          },
          this.signal,
        );
    }
    const caddyfile = join(this.directory, "Caddyfile");
    this.browserPort = await freeLoopbackPort();
    while (this.browserPort === this.port) this.browserPort = await freeLoopbackPort();
    await writeFile(caddyfile, renderCaddyfile(this.port));
    await this.container("caddy", caddyImage, [
      "--volume",
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      "--publish",
      `127.0.0.1:${this.port}:${this.port}`,
      "--publish",
      `127.0.0.1:${this.browserPort}:${this.browserPort}`,
    ]);
    await waitFor(
      "gateway route table",
      async () => {
        const url = `${this.origin}/health`;
        const response = await fetch(url, { ...localTls(url, this.origin), redirect: "error", signal: AbortSignal.timeout(5000) });
        const health = z.object({ routeTable: z.object({ routeCount: z.number() }) }).parse(await response.json());
        return response.ok && health.routeTable.routeCount >= apps.length - 1;
      },
      this.signal,
    );
    console.log(`Production gateway through Caddy TLS + HTTP/2: ${this.origin} (${this.prefix})`);
  }

  async startBrowsers(version: string) {
    if (this.browserPort === null) throw new Error("Caddy must publish the browser server port before browsers start");
    const server = browserServer(version, this.browserPort);
    await this.container("browsers", server.image, server.args, server.tail, undefined, `container:${this.name("caddy")}`);
    await waitFor(
      "Playwright browser server",
      async () => (await fetch(server.endpoint.replace("ws:", "http:"), { signal: AbortSignal.timeout(5000) })).ok,
      this.signal,
      60_000,
    );
    return server.endpoint;
  }

  async startFilegate() {
    const compose = await readFile(join(repository, "compose.yml"), "utf8");
    const image = /^  filegate:\s*\n\s+image:\s*(\S+)/m.exec(compose)?.[1];
    if (!image) throw new Error("Filegate image missing from compose.yml");
    const config = `server:\n  listen: "0.0.0.0:4000"\n  public_url: "http://filegate:4000"\n  allowed_origins: ${JSON.stringify([this.origin])}\nauth:\n  token_file: /etc/filegate/token\nstate_dir: /var/lib/filegate\nuploads:\n  max_file_size: 1GiB\nroots:\n  - name: cloud\n    path: /data/cloud\n    managed: true\n    index: true\n    versioning:\n      enabled: true\n  - name: freeipa\n    path: /data/freeipa\n    execution: true\n    index: false\n`;
    await writeFile(join(this.directory, "filegate.yaml"), config);
    await writeFile(join(this.directory, "filegate-token"), this.filegateToken, { mode: 0o600 });
    await this.container("filegate", image, [
      "--user",
      "0:0",
      "--volume",
      `${join(this.directory, "filegate.yaml")}:/etc/filegate/conf.yaml:ro`,
      "--volume",
      `${join(this.directory, "filegate-token")}:/etc/filegate/token:ro`,
      "--volume",
      `${await this.volume("filegate-cloud")}:/data/cloud`,
      "--volume",
      `${await this.volume("filegate-freeipa")}:/data/freeipa`,
      "--volume",
      `${await this.volume("filegate-state")}:/var/lib/filegate`,
    ]);
    try {
      await waitFor(
        "Filegate",
        async () => {
          await command(["docker", "exec", this.name("filegate"), "/app/filegate", "status"], { timeoutMs: 5000, signal: this.signal });
          return true;
        },
        this.signal,
        60_000,
      );
    } catch (error) {
      await this.logs();
      throw error;
    }
  }

  private async labelled(kind: "container" | "volume" | "network", attempted: string[]) {
    if (!attempted.length) return [];
    const output = await command([
      "docker",
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--filter",
      `label=cloud.perf.run=${this.prefix}`,
      "--format",
      kind === "container" ? "{{.Names}}" : "{{.Name}}",
    ]);
    const owned = new Set(output.split("\n"));
    return attempted.filter((name) => owned.has(name));
  }

  async logs() {
    for (const name of await this.labelled("container", this.containers)) {
      const output = await command(["docker", "logs", "--tail", "60", name], { includeStderr: true }).catch((error: unknown) =>
        String(error),
      );
      console.error(
        `\n${name}:\n${[this.adminToken, this.filegateToken, this.appSecret].reduce((text, secret) => text.replaceAll(secret, "[redacted]"), output)}`,
      );
    }
  }

  async cleanup(keep: boolean) {
    // Resolve attempted names by the exact run label; missing or differently labelled names are not ours.
    // Never filter by name prefix or prune. Cleanup must also work after the run signal was aborted.
    const failures: string[] = [];
    const owned = async (kind: "container" | "volume" | "network", attempted: string[]) =>
      this.labelled(kind, attempted).catch((error: unknown) => {
        failures.push(String(error));
        return [];
      });
    const [containers, volumes, networks] = await Promise.all([
      owned("container", this.containers),
      owned("volume", this.volumes),
      owned("network", this.networks),
    ]);
    if (keep) {
      if (failures.length) throw new Error(`Cannot resolve kept resources: ${failures.join("; ")}`);
      console.log(
        `Kept resources. Remove exactly this run:\n${containers.length ? `docker rm -f ${containers.toReversed().join(" ")}\n` : ""}${volumes.length ? `docker volume rm ${volumes.join(" ")}\n` : ""}${networks.length ? `docker network rm ${networks.join(" ")}\n` : ""}Then remove private fixture files: ${this.directory}`,
      );
      return;
    }
    for (const name of containers.toReversed()) {
      await command(["docker", "rm", "--force", "--volumes", name]).catch((error: unknown) => failures.push(String(error)));
    }
    for (const name of volumes) {
      await command(["docker", "volume", "rm", name]).catch((error: unknown) => failures.push(String(error)));
    }
    for (const name of networks) {
      await command(["docker", "network", "rm", name]).catch((error: unknown) => failures.push(String(error)));
    }
    if (failures.length) throw new Error(`Cleanup failed; resources carry ${this.prefix}: ${failures.join("; ")}`);
    await rm(this.directory, { recursive: true, force: true });
  }
}
