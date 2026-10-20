import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// The handler serves `public/` below the working directory.
const root = mkdtempSync(join(tmpdir(), "cloud-static-assets-"));
mkdirSync(join(root, "public"));
const css = join(root, "public", "global.css");
writeFileSync(css, "body{color:red}");
utimesSync(css, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
const cwd = process.cwd();
process.chdir(root);
const { publicFileVersion, servePublicAsset, sharedStylesheetVersion, versionedPublicHref } = await import("./static-assets");
afterAll(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const serve = (isDevelopment: boolean, release?: string) => new Hono().all("/public/*", servePublicAsset(isDevelopment, release));
const immutable = "public, max-age=31536000, immutable";
const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);

describe("public assets", () => {
  test("in development, an unchanged file costs one round trip instead of its whole size", async () => {
    const app = serve(true);
    const first = await app.request("/public/global.css");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    expect(await first.text()).toBe("body{color:red}");
    const etag = first.headers.get("ETag")!;

    const again = await app.request("/public/global.css", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(await again.text()).toBe("");

    // A rebuild under the same address is new content.
    writeFileSync(css, "body{color:blue}");
    utimesSync(css, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:05Z"));
    const rebuilt = await app.request("/public/global.css", { headers: { "If-None-Match": etag } });
    expect(rebuilt.status).toBe(200);
    expect(await rebuilt.text()).toBe("body{color:blue}");
  });

  test("development ignores version queries and still revalidates", async () => {
    const app = serve(true, "sha-0123456789ab");
    const response = await app.request("/public/global.css?v=anything");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const again = await app.request("/public/global.css?v=anything", { headers: { "If-None-Match": response.headers.get("ETag")! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("shared stylesheets are immutable only for the serving Core build", async () => {
    for (const name of ["fonts", "tabler-icons", "global"]) {
      writeFileSync(join(root, "public", `${name}.css`), `${name}{color:red}`);
      for (const [query, cache] of [
        ["?v=sha-0123456789ab", immutable],
        ["?v=sha-other", "no-cache"],
        ["", "no-cache"],
      ] as const) {
        const response = await serve(false, "sha-0123456789ab").request(`/public/${name}.css${query}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe(cache);
      }
    }
    const unnamed = await serve(false, undefined).request("/public/global.css?v=local");
    expect(unnamed.headers.get("Cache-Control")).toBe("no-cache");
    const encoded = await serve(false, "sha/one two").request("/public/%67lobal.css?v=sha%2Fone+two");
    expect(encoded.headers.get("Cache-Control")).toBe(immutable);
  });

  test("own page-head assets use their source content hash, even when compressed", async () => {
    mkdirSync(join(root, "public", "probe"));
    for (const name of ["app.css", "favicon.svg"]) {
      const content = name === "app.css" ? "body{color:green}" : "<svg/>";
      const pathname = `/public/probe/${name}`;
      writeFileSync(join(root, pathname), content);
      writeFileSync(join(root, `${pathname}.br`), "brotli fixture bytes");
      writeFileSync(join(root, `${pathname}.gz`), "gzip fixture bytes");
      expect(publicFileVersion(pathname)).toBe(hash(content));
      for (const encoding of ["identity", "br", "gzip"]) {
        for (const [query, cache] of [
          [`?v=${hash(content)}`, immutable],
          ["?v=wrong", "no-cache"],
          ["", "no-cache"],
        ] as const) {
          const response = await serve(false).request(`${pathname}${query}`, { headers: { "Accept-Encoding": encoding } });
          expect(response.status).toBe(200);
          expect(response.headers.get("Cache-Control")).toBe(cache);
          expect(response.headers.get("Vary")).toBe("Accept-Encoding");
          expect(response.headers.get("Content-Encoding")).toBe(encoding === "identity" ? null : encoding);
        }
      }
    }
  });

  test("other public files stay immutable without a version query", async () => {
    writeFileSync(join(root, "public", "logo.svg"), "<svg/>");
    const response = await serve(false).request("/public/logo.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(immutable);
  });

  test("304 preserves the ETag and the same cache policy as 200", async () => {
    const app = serve(false, "sha-0123456789ab");
    for (const [version, cache] of [
      ["sha-0123456789ab", immutable],
      ["sha-other", "no-cache"],
    ] as const) {
      const pathname = `/public/global.css?v=${version}`;
      const first = await app.request(pathname);
      const etag = first.headers.get("ETag")!;
      expect(etag).toMatch(/^"identity-[a-z0-9]+-[a-z0-9]+"$/);
      expect(first.headers.get("Cache-Control")).toBe(cache);
      for (const condition of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const again = await app.request(pathname, { headers: { "If-None-Match": condition } });
        expect(again.status).toBe(304);
        expect(again.headers.get("ETag")).toBe(etag);
        expect(again.headers.get("Cache-Control")).toBe(cache);
        expect(again.headers.get("Vary")).toBe("Accept-Encoding");
        expect(await again.text()).toBe("");
      }
    }
  });

  test("a missing file has no version until it exists; an in-place change gets a new version", () => {
    const pathname = "/public/later.css";
    expect(publicFileVersion(pathname)).toBeUndefined();
    writeFileSync(join(root, pathname), "later{}");
    utimesSync(join(root, pathname), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(publicFileVersion(pathname)).toBe(hash("later{}"));
    writeFileSync(join(root, pathname), "changed{}");
    utimesSync(join(root, pathname), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:10Z"));
    expect(publicFileVersion(pathname)).toBe(hash("changed{}"));
    mkdirSync(join(root, "public", "dir.css"));
    expect(publicFileVersion("/public/dir.css")).toBeUndefined();
    expect(publicFileVersion("/public/../outside.css")).toBeUndefined();
  });

  test("only named releases version shared sheets and href versions are encoded", () => {
    for (const release of [undefined, "", "local", "development"]) expect(sharedStylesheetVersion(release)).toBeUndefined();
    expect(sharedStylesheetVersion("sha-0123456789ab")).toBe("sha-0123456789ab");
    expect(versionedPublicHref("/public/global.css", undefined)).toBe("/public/global.css");
    expect(versionedPublicHref("/public/global.css", "sha/one two")).toBe("/public/global.css?v=sha%2Fone%20two");
  });
});
