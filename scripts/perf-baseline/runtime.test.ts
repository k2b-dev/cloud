import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  browserServer,
  caddyImage,
  command,
  localTls,
  measurementOrigin,
  Runtime,
  renderCaddyfile,
  repository,
  runtimeImage,
  unmountedVolumes,
  worktreePath,
} from "./runtime";

test("the measured origin used as APP_URL is HTTPS localhost on the chosen port", () => {
  expect(measurementOrigin(4100)).toBe("https://localhost:4100");
  const runtime = new Runtime(4100, "image", new AbortController().signal);
  expect(runtime.origin).toBe(measurementOrigin(4100));
  for (const port of [0, -1, 3000, 65536, 4100.5, Number.NaN]) expect(() => measurementOrigin(port)).toThrow();
});

test("Caddy terminates internal TLS with default HTTP/2 and passes gateway compression through", () => {
  expect(caddyImage).toMatch(/^caddy:\d+\.\d+\.\d+-alpine$/);
  expect(renderCaddyfile(4100)).toBe(`{
  admin off
  auto_https disable_redirects
}

https://localhost:4100 {
  tls internal
  reverse_proxy gateway:3000
}
`);
});

test("skipping certificate verification applies only to the exact local HTTPS origin", () => {
  const origin = measurementOrigin(4100);
  expect(localTls(`${origin}/health`, origin)).toEqual({ tls: { rejectUnauthorized: false } });
  expect(localTls(new URL("/api/auth/admin-login", origin), origin)).toEqual({ tls: { rejectUnauthorized: false } });
  for (const url of [
    "https://localhost:4101/health",
    "https://example.com/",
    "http://localhost:4100/health",
    "https://127.0.0.1:4100/health",
  ])
    expect(localTls(url, origin)).toEqual({});
  expect(localTls("https://example.com/health", "https://example.com")).toEqual({});
  expect(localTls("http://localhost:4100/health", "http://localhost:4100")).toEqual({});
});

test("both engines use the catalog-matching noble image with a server in Caddy’s namespace", () => {
  expect(browserServer("1.63.0", 4200)).toEqual({
    image: "mcr.microsoft.com/playwright:v1.63.0-noble",
    args: ["--init", "--ipc=host", "--user", "pwuser", "--workdir", "/home/pwuser"],
    tail: ["npx", "-y", "playwright@1.63.0", "run-server", "--port", "4200", "--host", "0.0.0.0"],
    endpoint: "ws://127.0.0.1:4200/",
  });
});

test("runtime base comes from the runtime stage, including its digest", () => {
  const image = `oven/bun:1.4.2-alpine@sha256:${"a".repeat(64)}`;
  expect(runtimeImage(`FROM other AS build\nFROM ${image} AS runtime\nUSER bun`)).toBe(image);
  expect(() => runtimeImage("FROM oven/bun:latest AS runtime")).toThrow();
  expect(() => runtimeImage(`FROM ${image} AS build`)).toThrow();
});

test("image-declared volumes get named mounts unless already covered by a bind or named volume", () => {
  expect(
    unmountedVolumes(
      ["/data", "/state", "/app"],
      ["--user", "bun", "--volume", "/checkout/dist:/app:ro", "--volume", "cloud-perf-data:/data"],
    ),
  ).toEqual(["/state"]);
  expect(unmountedVolumes(["/data"], [])).toEqual(["/data"]);
  expect(() => unmountedVolumes(["/data"], ["--volume"])).toThrow();
});

test("output and build paths reject escape via traversal or symlink without touching the target", async () => {
  expect(await worktreePath(".local/perf-baseline/new-run")).toBe(join(repository, ".local/perf-baseline/new-run"));
  expect(worktreePath("../foreign-checkout/result")).rejects.toThrow();
  const root = join(repository, ".local/perf-baseline-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "paths-"));
  try {
    await symlink("/", join(directory, "outside"));
    expect(worktreePath(join(directory, "outside", "result"))).rejects.toThrow("symlink");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all resource names share a unique per-run prefix, without Docker calls", () => {
  const signal = new AbortController().signal;
  const a = new Runtime(4100, "image", signal);
  const b = new Runtime(4100, "image", signal);
  expect(a.prefix).not.toBe(b.prefix);
  for (const service of ["app-core", "gateway", "postgres-data", "filegate-state", "caddy", "browsers"])
    expect(a.name(service)).toBe(`${a.prefix}-${service}`);
  expect(a.containers).toEqual([]);
  expect(a.volumes).toEqual([]);
  expect(a.networks).toEqual([]);
});

test("command aborts a running subprocess promptly", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const running = command(["sleep", "30"], { signal: controller.signal });
  const abort = setTimeout(() => controller.abort(new Error("test interruption")), 50);
  try {
    await expect(running).rejects.toThrow("test interruption");
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    clearTimeout(abort);
  }
});

// Substitute small Bun subprocesses for every command; these tests never invoke Docker or builds.
function stubCommands(reply: (args: string[]) => { output?: string; error?: string }) {
  const spawn = Bun.spawn;
  const calls: string[][] = [];
  function substitute<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(
    input: string[] | (Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }),
    options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
  ) {
    const args = Array.isArray(input) ? input : input.cmd;
    calls.push(args);
    const { output = "", error = "" } = reply(args);
    return spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        "process.stdout.write(process.argv[1]);process.stderr.write(process.argv[2]);process.exit(Number(process.argv[3]))",
        output,
        error,
        error ? "1" : "0",
      ],
      Array.isArray(input) ? options : input,
    );
  }
  const stub = spyOn(Bun, "spawn").mockImplementation(substitute);
  return { calls, restore: () => stub.mockRestore() };
}

test("failed ownership inspection retains the attempted container and cleanup resolves its exact label", async () => {
  const runtime = new Runtime(4100, "image", new AbortController().signal);
  const stub = stubCommands((args) => {
    if (args[1] === "image") return { output: "null" };
    if (args[2] === "inspect") return { error: "ownership inspect unavailable" };
    if (args[2] === "ls") return { output: runtime.name("browsers") };
    return {};
  });
  try {
    await expect(runtime.container("browsers", "image", [], [], undefined, `container:${runtime.name("caddy")}`)).rejects.toThrow(
      "ownership inspect unavailable",
    );
    expect(runtime.containers).toEqual([runtime.name("browsers")]);
    const run = stub.calls.find((args) => args[1] === "run");
    expect(run).toContain(`container:${runtime.name("caddy")}`);
    expect(run).not.toContain("--network-alias");
    await runtime.cleanup(false);
    expect(stub.calls).toContainEqual([
      "docker",
      "container",
      "ls",
      "--all",
      "--filter",
      `label=cloud.perf.run=${runtime.prefix}`,
      "--format",
      "{{.Names}}",
    ]);
    expect(stub.calls).toContainEqual(["docker", "rm", "--force", "--volumes", runtime.name("browsers")]);
  } finally {
    stub.restore();
  }
});

test("failed volume inspection retains the attempted volume for cleanup", async () => {
  const runtime = new Runtime(4100, "image", new AbortController().signal);
  const volume = runtime.name("caddy-volume-0");
  const stub = stubCommands((args) => {
    if (args[1] === "image") return { output: '{"/data":{}}' };
    if (args[2] === "inspect") return { error: "ownership inspect unavailable" };
    if (args[2] === "ls") return { output: volume };
    return {};
  });
  try {
    await expect(runtime.container("caddy", "image")).rejects.toThrow("ownership inspect unavailable");
    expect(runtime.volumes).toEqual([volume]);
    expect(runtime.containers).toEqual([]);
    await runtime.cleanup(false);
    expect(stub.calls).toContainEqual(["docker", "volume", "rm", volume]);
  } finally {
    stub.restore();
  }
});

test("failed network creation records the attempt and cleanup finds its label", async () => {
  const runtime = new Runtime(4100, "image", new AbortController().signal);
  const stub = stubCommands((args) => (args[2] === "create" ? { error: "creation interrupted" } : { output: runtime.prefix }));
  try {
    await expect(runtime.start([])).rejects.toThrow("creation interrupted");
    expect(runtime.networks).toEqual([runtime.prefix]);
    await runtime.cleanup(false);
    expect(stub.calls).toContainEqual(["docker", "network", "rm", runtime.prefix]);
  } finally {
    stub.restore();
  }
});

test("cleanup ignores unlabelled attempted names and removes labelled containers in reverse creation order", async () => {
  const controller = new AbortController();
  const runtime = new Runtime(4100, "image", controller.signal);
  runtime.containers.push(runtime.name("caddy"), runtime.name("collision"), runtime.name("browsers"));
  runtime.volumes.push(runtime.name("missing-volume"));
  runtime.networks.push(runtime.prefix);
  controller.abort(new Error("interrupted"));
  const stub = stubCommands((args) => {
    if (args[1] === "container" && args[2] === "ls")
      return { output: [runtime.name("browsers"), runtime.name("caddy"), runtime.name("unattempted")].join("\n") };
    if (args[1] === "network" && args[2] === "ls") return { output: runtime.prefix };
    return {};
  });
  try {
    await runtime.cleanup(false);
    expect(stub.calls.filter((args) => args[1] === "rm")).toEqual([
      ["docker", "rm", "--force", "--volumes", runtime.name("browsers")],
      ["docker", "rm", "--force", "--volumes", runtime.name("caddy")],
    ]);
    expect(stub.calls.filter((args) => args[1] === "volume")).toHaveLength(1);
    expect(stub.calls).toContainEqual(["docker", "network", "rm", runtime.prefix]);
    expect(stub.calls.some((args) => args.includes("prune") || args.some((arg) => arg.startsWith("name=")))).toBe(false);
  } finally {
    stub.restore();
  }
});

test("logs and keep commands include only labelled attempted resources", async () => {
  const runtime = new Runtime(4100, "image", new AbortController().signal);
  runtime.containers.push(runtime.name("caddy"), runtime.name("collision"), runtime.name("browsers"));
  runtime.volumes.push(runtime.name("data"), runtime.name("missing"));
  const stub = stubCommands((args) => {
    if (args[1] === "container" && args[2] === "ls") return { output: [runtime.name("caddy"), runtime.name("browsers")].join("\n") };
    if (args[1] === "volume" && args[2] === "ls") return { output: runtime.name("data") };
    return {};
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await runtime.logs();
    await runtime.cleanup(true);
    expect(stub.calls.filter((args) => args[1] === "logs").map((args) => args.at(-1))).toEqual([
      runtime.name("caddy"),
      runtime.name("browsers"),
    ]);
    expect(log.mock.calls[0]?.[0]).toContain(`docker rm -f ${runtime.name("browsers")} ${runtime.name("caddy")}`);
    expect(log.mock.calls[0]?.[0]).toContain(`docker volume rm ${runtime.name("data")}`);
    expect(log.mock.calls[0]?.[0]).not.toContain(runtime.name("collision"));
    expect(log.mock.calls[0]?.[0]).not.toContain(runtime.name("missing"));
    expect(stub.calls.some((args) => args[1] === "rm")).toBe(false);
  } finally {
    error.mockRestore();
    log.mockRestore();
    stub.restore();
  }
});

test("an aborted run that created a container still cleans up its exact labelled attempt", async () => {
  const controller = new AbortController();
  const runtime = new Runtime(4100, "image", controller.signal);
  const stub = stubCommands((args) => {
    if (args[1] === "image") return { output: "null" };
    if (args[1] === "run") controller.abort(new Error("creation interrupted"));
    if (args[2] === "ls") return { output: runtime.name("browsers") };
    return {};
  });
  try {
    await expect(runtime.container("browsers", "image")).rejects.toThrow();
    expect(runtime.containers).toEqual([runtime.name("browsers")]);
    await runtime.cleanup(false);
    expect(stub.calls).toContainEqual(["docker", "rm", "--force", "--volumes", runtime.name("browsers")]);
  } finally {
    stub.restore();
  }
});
