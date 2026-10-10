import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  caddyImage,
  localTls,
  measurementOrigin,
  Runtime,
  renderCaddyfile,
  repository,
  runtimeImage,
  unmountedVolumes,
  webkitServer,
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
  expect(renderCaddyfile()).toBe(`{
  admin off
  auto_https disable_redirects
}

https://localhost:443 {
  tls internal
  reverse_proxy gateway:3000
}
`);
});

test("private CA trust applies only to the exact local HTTPS origin", () => {
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

test("WebKit uses the catalog-matching noble image and a loopback browser server", () => {
  expect(webkitServer("1.63.0", 4200)).toEqual({
    image: "mcr.microsoft.com/playwright:v1.63.0-noble",
    args: ["--init", "--ipc=host", "--user", "pwuser", "--workdir", "/home/pwuser"],
    tail: ["npx", "-y", "playwright@1.63.0", "run-server", "--port", "4200", "--host", "127.0.0.1"],
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
  for (const service of ["app-core", "gateway", "postgres-data", "filegate-state", "caddy", "webkit"])
    expect(a.name(service)).toBe(`${a.prefix}-${service}`);
  expect(a.containers).toEqual([]);
  expect(a.volumes).toEqual([]);
});
