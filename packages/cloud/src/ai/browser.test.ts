import { afterEach, describe, expect, test } from "bun:test";
import { launchAssistant } from "./browser";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("launchAssistant", () => {
  test("creates a structured draft and returns the Assistant deep link", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        calls.push([request, init]);
        return Response.json({ id: "cHt234", shortId: "cHt234", draft: { content: [], revision: 1, updatedAt: null } }, { status: 201 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const input = {
      launchedByAppId: "mail",
      draft: {
        content: [
          {
            type: "resource" as const,
            ref: { type: "mail.draft", id: "Draft1" },
            title: "Quarterly update",
            icon: "ti ti-mail",
            href: "/app/mail/drafts/Draft1",
          },
        ],
      },
      preloadTools: [{ appId: "mail", kind: "query" as const, id: "draft.read" }, { name: "text_editor" }],
    };
    const launch = await launchAssistant(input);

    expect(launch.href).toBe("/app/assistant?conversation=cHt234");
    expect(calls).toEqual([
      [
        "/api/ai/conversations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ],
    ]);
  });

  test("uploads browser files before saving their exact draft versions", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        calls.push([path, init]);
        if (path === "/api/ai/conversations") {
          return Response.json({ id: "cHt234", shortId: "cHt234", draft: { content: [], revision: 0, updatedAt: null } }, { status: 201 });
        }
        if (path.endsWith("/files")) {
          return Response.json({ file: { path: "/brief.txt", mediaType: "text/plain", size: 5, version: 2 } });
        }
        return Response.json({
          content: [{ type: "file", path: "/brief.txt", mediaType: "text/plain", size: 5, version: 2 }],
          revision: 1,
          updatedAt: "2026-08-18T00:00:00.000Z",
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    const launch = await launchAssistant({ files: [new File(["brief"], "brief.txt", { type: "text/plain" })] });

    expect(launch.conversation.draft.revision).toBe(1);
    expect(calls.map(([path, init]) => `${init?.method} ${path}`)).toEqual([
      "POST /api/ai/conversations",
      "POST /api/ai/conversations/cHt234/files",
      "PUT /api/ai/conversations/cHt234/draft",
    ]);
    expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({
      expectedRevision: 0,
      content: [{ type: "file", path: "/brief.txt", mediaType: "text/plain", size: 5, version: 2 }],
    });
  });
});
