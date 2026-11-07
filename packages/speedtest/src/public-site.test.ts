import { expect, test } from "bun:test";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A production bundle catches island discovery, manifest and runtime asset seams. */
test("standalone production page serves localized SSR and local assets without cookies or Cloud", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const outdir = await mkdtemp(join(tmpdir(), "speedtest-site-"));
  const removeBuild = async (directory: string): Promise<void> => {
    // Enumerate the owned build before deleting individual files and empty directories.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await removeBuild(path);
      else await unlink(path);
    }
    await rmdir(directory);
  };
  let process: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let build: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    build = Bun.spawn(["bun", "packages/speedtest/scripts/build.ts", "--outdir", outdir], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    if (code !== 0) throw new Error(`Production build failed: ${stdout}\n${stderr}`);
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    await reservation.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    process = Bun.spawn(["bun", join(outdir, "server.js")], {
      cwd: outdir,
      env: { ...Bun.env, SPEEDTEST_HOST: "127.0.0.1", SPEEDTEST_PORT: String(port), SPEEDTEST_PUBLIC_URL: origin, SPEEDTEST_UDP_PORT: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = process.stdout.getReader();
    const deadline = setTimeout(() => {
      void reader.cancel();
    }, 10_000);
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("Speedtest HTTP listening");
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
    }
    const local = (path: string) => fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5_000) });
    for (const [locale, title, action] of [
      ["de", "Internet-Speedtest", "Test starten"],
      ["en", "Internet speed test", "Start test"],
    ]) {
      const response = await local(`/${locale}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-language")).toBe(locale!);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.get("content-security-policy")).toContain("font-src 'self' data:");
      const html = await response.text();
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).toContain(action!);
      expect(html).toContain("tools-speedtest-terminal");
      expect(html).toContain(`rel="canonical" href="${origin}/${locale}"`);
      expect(html).toContain(origin);
      const stylesheet = html.match(/href="(\/assets\/site-[a-z0-9]+\.css)"/)?.[1];
      expect(stylesheet).toBeDefined();
      const css = await local(stylesheet!);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(await css.text()).toContain("tools-speedtest-controls");
      const prefix = html.match(/data-ssr-assets="([^"<>]+)"/)?.[1];
      expect(prefix).toMatch(/^\/_ssr\/[a-z0-9]+$/);
      const scripts = [...html.matchAll(/data-id="([a-z0-9]+)"/g)].map((match) => `${prefix}/${match[1]}.js`);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        const asset = await local(script);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toContain("javascript");
        expect(asset.headers.has("set-cookie")).toBe(false);
        await asset.body?.cancel();
      }
    }
    expect((await local("/download?size=1")).status).toBe(401);
    for (let index = 0; index < 2; index++) {
      const session = await fetch(`${origin}/session`, { method: "POST" });
      expect(session.status).toBe(201);
      const data: unknown = await session.json();
      if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string")
        throw new Error("Missing session token");
      const token = data.token;
      const end = await fetch(`${origin}/session/end`, { method: "POST", headers: { "X-Speedtest-Token": token } });
      expect(end.status).toBe(204);
    }
    const limited = await fetch(`${origin}/session`, { method: "POST" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  } finally {
    build?.kill();
    await build?.exited;
    process?.kill();
    await process?.exited;
    await removeBuild(outdir);
  }
}, 60_000);
