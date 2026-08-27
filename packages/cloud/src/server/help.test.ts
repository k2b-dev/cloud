import { describe, expect, test } from "bun:test";
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

describe("defineHelpCollection", () => {
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

    const searchResponse = await collection.router.request("/search?q=documentation");
    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toEqual({ ids: ["getting-started"], locale: "en" });

    const response = await collection.router.request("/getting-started");
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
    expect((await collection.router.request("/missing")).status).toBe(404);
  });
});
