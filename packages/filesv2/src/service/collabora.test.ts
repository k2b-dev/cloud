import { beforeEach, describe, expect, test } from "bun:test";
import { DISCOVERY_CACHE_MS, discoverEditor, parseDiscovery, resetDiscoveryCache, signEditorToken, verifyEditorToken } from "./collabora";

const DISCOVERY = `<?xml version="1.0"?><wopi-discovery><net-zone name="external-http">
<app name="writer"><action default="true" ext="odt" name="edit" urlsrc="http://collabora:9980/browser/abc/cool.html?"/>
<action ext="odt" name="view" urlsrc="http://collabora:9980/browser/abc/cool.html?"/>
<action ext="ott" name="editnew" newext="odt" urlsrc="http://collabora:9980/browser/abc/cool.html?"/></app>
<app name="calc"><action name="edit" ext="ods" urlsrc="http://collabora:9980/browser/abc/cool.html?"/></app>
</net-zone></wopi-discovery>`;

describe("editor tokens", () => {
  const payload = {
    userId: "6f0f2a4e-6d0d-4b3e-9d0e-3f1a8c1f0a11",
    baseId: "cloud:users:u1",
    path: "Docs/report.odt",
    expiresAt: Date.now() + 60_000,
  };
  test("round-trips and rejects tampering, foreign signatures and expiry", () => {
    const token = signEditorToken(payload);
    expect(verifyEditorToken(token)).toEqual(payload);
    const [body, signature] = token.split(".");
    expect(verifyEditorToken(`${body}.${signature!.slice(1)}x`)).toBeNull();
    const forged = Buffer.from(
      JSON.stringify({ u: payload.userId, b: payload.baseId, p: "Docs/other.odt", e: payload.expiresAt }),
    ).toString("base64url");
    expect(verifyEditorToken(`${forged}.${signature}`)).toBeNull();
    expect(verifyEditorToken(token, payload.expiresAt + 1)).toBeNull();
    expect(verifyEditorToken("")).toBeNull();
    expect(verifyEditorToken("a.b.c")).toBeNull();
  });
});

describe("Collabora discovery", () => {
  beforeEach(() => resetDiscoveryCache());
  test("parses edit and view actions per extension regardless of attribute order", () => {
    const actions = parseDiscovery(DISCOVERY);
    expect(actions.get("odt")).toEqual({
      edit: "http://collabora:9980/browser/abc/cool.html?",
      view: "http://collabora:9980/browser/abc/cool.html?",
    });
    expect(actions.get("ods")).toEqual({ edit: "http://collabora:9980/browser/abc/cool.html?" });
    expect(actions.has("ott")).toBe(false);
  });
  test("reads through the internal address, answers with the browser address and caches for an hour", async () => {
    const calls: string[] = [];
    const transfer = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(DISCOVERY);
    }) as unknown as typeof fetch;
    const options = { url: "https://office.example.org", internalUrl: "http://collabora:9980", extension: "odt", action: "edit" as const };
    expect(await discoverEditor(options, transfer, 1_000)).toBe("https://office.example.org/browser/abc/cool.html?");
    expect(await discoverEditor({ ...options, action: "view" }, transfer, 2_000)).toBe("https://office.example.org/browser/abc/cool.html?");
    expect(calls).toEqual(["http://collabora:9980/hosting/discovery"]);
    await discoverEditor(options, transfer, 1_000 + DISCOVERY_CACHE_MS + 1);
    expect(calls).toHaveLength(2);
  });
  test("reports unsupported extensions and an unreachable server distinctly", async () => {
    const transfer = (async () => new Response(DISCOVERY)) as unknown as typeof fetch;
    const options = { url: "https://office.example.org", internalUrl: "", extension: "pptx", action: "edit" as const };
    await expect(discoverEditor(options, transfer)).rejects.toMatchObject({ code: "editor_unsupported", status: 400 });
    const failing = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    resetDiscoveryCache();
    await expect(discoverEditor({ ...options, extension: "odt" }, failing)).rejects.toMatchObject({
      code: "editor_unavailable",
      status: 503,
    });
  });
});

test("WOPI timestamp comparison preserves microseconds and normalizes timezone and precision", async () => {
  const { wopiTimestamp } = await import("./collabora");
  expect(wopiTimestamp("2026-09-20T10:00:00.123456789Z")).toBe("2026-09-20T10:00:00.123456Z");
  expect(wopiTimestamp("2026-09-20T12:00:00.123456+02:00")).toBe("2026-09-20T10:00:00.123456Z");
  expect(wopiTimestamp("2026-09-20T10:00:00.123456Z")).not.toBe(wopiTimestamp("2026-09-20T10:00:00.123457Z"));
  expect(wopiTimestamp("2026-09-20T10:00:00Z")).toBe("2026-09-20T10:00:00.000000Z");
  expect(wopiTimestamp("not a date")).toBe("");
});
