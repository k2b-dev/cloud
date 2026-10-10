import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { defineHelpCollection } from "./help";

const source = `---
id: getting-started
title: Getting started
icon: ti ti-rocket
description: First steps
order: 10
---

# Welcome

[Open the app](/app/example)

\`\`\`script
throw new Error("documentation must not execute");
\`\`\`
`;

const signedIn = { headers: { Accept: "application/json", Cookie: "session_token=test" } };

describe("defineHelpCollection", () => {
  let authenticate: ReturnType<typeof spyOn<typeof session, "authenticateRequest">>;
  beforeAll(() => {
    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "guest", effective_admin: false });
    authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
  });
  afterAll(() => authenticate.mockRestore());

  test("answers only signed-in people", async () => {
    const collection = defineHelpCollection({ basePath: "/help", sources: [source] });
    for (const path of ["/search?q=documentation", "/getting-started", "/missing"]) {
      expect((await collection.router.request(path, { headers: { Accept: "application/json" } })).status).toBe(401);
    }
  });

  test("keeps the manifest metadata-only and searches content on the server", async () => {
    const collection = defineHelpCollection({ basePath: "/api/example/help", sources: [source] });
    expect(collection.manifest).toEqual([
      expect.objectContaining({
        id: "getting-started",
        title: "Getting started",
        order: 10,
        searchUrl: "/api/example/help/search",
        url: "/api/example/help/getting-started",
      }),
    ]);
    expect(collection.manifest[0]).not.toHaveProperty("searchText");

    const searchResponse = await collection.router.request("/search?q=documentation", signedIn);
    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toEqual({ ids: ["getting-started"], locale: "en" });

    const response = await collection.router.request("/getting-started", signedIn);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.markdown).toContain("documentation must not execute");
    expect(payload.html).not.toContain("data-script-source");
    expect(payload.html).toContain('href="/app/example"');
    expect(payload.html).not.toContain('target="_blank"');
  });

  test("rejects duplicate ids at startup", () => {
    expect(() => defineHelpCollection({ basePath: "/help", sources: [source, source] })).toThrow("Duplicate help document id");
  });

  test("returns a clear 404 for unknown documents", async () => {
    const collection = defineHelpCollection({ basePath: "/help", sources: [source] });
    expect((await collection.router.request("/missing", signedIn)).status).toBe(404);
  });
});
