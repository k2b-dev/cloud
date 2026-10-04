import { describe, expect, test } from "bun:test";
import type { AppIconVariant } from "@k2b/cloud/services/branding/app-icons";
import { Hono } from "hono";
import { createAppIconRoutes } from "./app-icons";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const routes = (options: { version?: string; fail?: boolean } = {}) => {
  const rendered: AppIconVariant[] = [];
  const app = new Hono().route(
    "/branding",
    createAppIconRoutes({
      version: async () => options.version ?? "0123456789ab",
      render: async (variant) => {
        rendered.push(variant);
        if (options.fail) throw new Error("Icon rendering failed.");
        return { png, etag: `"${options.version ?? "0123456789ab"}"` };
      },
    }),
  );
  return { app, rendered };
};

describe("app icon routes", () => {
  test("serve every icon as a PNG that browsers revalidate", async () => {
    const { app, rendered } = routes();
    for (const name of ["pwa-icon-192", "pwa-icon-512", "pwa-icon-maskable-512", "apple-touch-icon"]) {
      const response = await app.request(`/branding/${name}.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("etag")).toBe('"0123456789ab"');
      expect(response.headers.get("cache-control")).toBe("public, no-cache");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    }
    expect(rendered).toEqual(["pwa-icon-192", "pwa-icon-512", "pwa-icon-maskable-512", "apple-touch-icon"]);
    expect((await app.request("/branding/pwa-icon-1024.png")).status).toBe(404);
  });

  test("answer 304 without drawing while the logo is unchanged, and the new icon after a change", async () => {
    let { app, rendered } = routes();
    for (const header of ['"0123456789ab"', 'W/"0123456789ab"', '"other", "0123456789ab"']) {
      const response = await app.request("/branding/pwa-icon-512.png", { headers: { "If-None-Match": header } });
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe('"0123456789ab"');
    }
    expect(rendered).toEqual([]);
    ({ app, rendered } = routes({ version: "ba9876543210" }));
    const response = await app.request("/branding/pwa-icon-512.png", { headers: { "If-None-Match": '"0123456789ab"' } });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"ba9876543210"');
  });

  test("answer 503 without caching when the icons cannot be drawn", async () => {
    const response = await routes({ fail: true }).app.request("/branding/apple-touch-icon.png");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
