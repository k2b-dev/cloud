import { expect, test } from "bun:test";
import { createArtifactServiceRoutes } from "./api";
import { createRunnerRoutes } from "./runner-api";
import { chunkSource } from "./runtime/chunks";

for (const [label, makeRoutes, path] of [
  ["runtime", createArtifactServiceRoutes, "/runtime/chunks/csv"],
  ["runner", createRunnerRoutes, "/chunks/csv"],
] as const)
  test(`${label} chunk validates cached bytes with an ETag and 304`, async () => {
    const routes = makeRoutes();
    const first = await routes.request(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(await first.text()).toBe(await chunkSource("csv"));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const cached = await routes.request(path, { headers: { "If-None-Match": etag! } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(cached.headers.get("cache-control")).toBe("no-cache");
    expect(await cached.text()).toBe("");
  }, 30000);
