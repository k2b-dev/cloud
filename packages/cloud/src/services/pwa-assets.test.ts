import { expect, spyOn, test } from "bun:test";
import * as registry from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import { pwaStaticAssets } from "./pwa-assets";

const entry = (id: string, pwa = false): AppRegistryEntry => ({
  id,
  name: id,
  icon: "ti ti-app",
  description: "",
  routes: [],
  baseUrl: `http://${id}:3000`,
  ...(pwa ? { pwa: { href: `/pwa/${id}` } } : {}),
});
const asset = (id: string) => ({
  url: `/${id}/_ssr/0123456789abcdef/chunk.js`,
  sha256: "a".repeat(64),
  bytes: 100,
  type: "text/javascript",
});

test("only currently registered shell, Core and parts contribute trusted output", async () => {
  const apps = spyOn(registry, "listApps").mockResolvedValue([entry("pwa"), entry("core"), entry("chat", true), entry("private")]);
  const calls: string[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        calls.push(url.hostname);
        expect(url.pathname).toBe("/_internal/pwa-assets");
        return Response.json([asset(url.hostname)]);
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    expect((await pwaStaticAssets()).map((a) => a.url)).toEqual([asset("chat").url, asset("core").url, asset("pwa").url]);
    apps.mockResolvedValue([entry("core")]);
    expect(await pwaStaticAssets()).toEqual([asset("core")]);
    expect(calls).toEqual(["chat", "core", "pwa", "core"]);
  } finally {
    network.mockRestore();
    apps.mockRestore();
  }
});

test("older apps participate after rebuilding; invalid or failed catalogs are left out without blocking the others", async () => {
  const apps = spyOn(registry, "listApps").mockResolvedValue([entry("chat", true)]);
  const network = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
  try {
    expect(await pwaStaticAssets()).toEqual([]);
    network.mockResolvedValue(Response.json([{ ...asset("chat"), url: "/api/chat/messages" }]));
    expect(await pwaStaticAssets()).toEqual([]);
    apps.mockResolvedValue([entry("chat", true), entry("core")]);
    network.mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const host = new URL(String(input)).hostname;
          if (host === "chat") return new Response(null, { status: 503 });
          return Response.json([asset(host)]);
        },
        { preconnect: () => undefined },
      ),
    );
    expect(await pwaStaticAssets()).toEqual([asset("core")]);
    network.mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const host = new URL(String(input)).hostname;
          if (host === "chat") throw new TypeError("connection refused");
          return Response.json([asset(host)]);
        },
        { preconnect: () => undefined },
      ),
    );
    expect(await pwaStaticAssets()).toEqual([asset("core")]);
  } finally {
    network.mockRestore();
    apps.mockRestore();
  }
});
