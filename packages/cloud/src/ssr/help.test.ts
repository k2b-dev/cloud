import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../server";
import * as helpService from "../services/help";
import { getLayoutHelp, layoutHelpFailed, preloadLayoutHelp, preloadLayoutHelpArticle } from "./help";

test("Help metadata needs a signed-in user, also for an explicit app", async () => {
  const reader = spyOn(helpService, "createHelpReader");
  try {
    const response = await new Hono<{ Variables: { runtime: { apps: [] } } }>()
      .get("/", async (c) => {
        c.set("runtime", { apps: [] });
        return c.json({
          explicit: await preloadLayoutHelp(c, "grids"),
          current: await preloadLayoutHelp(c),
          layout: getLayoutHelp(c),
          article: await preloadLayoutHelpArticle(c, "grids", "start"),
        });
      })
      .request("/");
    expect(await response.json()).toEqual({ explicit: null, current: null, layout: null, article: null });
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});

for (const failed of [false, true]) {
  test(`Help metadata ${failed ? "records a failed read" : "does not treat a null manifest as a failure"}`, async () => {
    const reader = spyOn(helpService, "createHelpReader").mockReturnValue({
      manifest: async () => {
        if (failed) throw new Error("Help store unavailable");
        return null;
      },
      list: async () => [],
      read: async () => null,
      search: async () => [],
    });
    try {
      const response = await new Hono<{ Variables: { runtime: { apps: [] }; user: { id: string } } }>()
        .get("/", async (c) => {
          c.set("runtime", { apps: [] });
          c.set("user", { id: "help-reader" });
          expect(layoutHelpFailed(c)).toBe(false);
          expect(await preloadLayoutHelp(c, "grids")).toBeNull();
          expect(await preloadLayoutHelp(c, "grids")).toBeNull();
          return c.json({ failed: layoutHelpFailed(c), layout: getLayoutHelp(c) });
        })
        .request("/");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ failed, layout: null });
      expect(reader).toHaveBeenCalledTimes(1);
    } finally {
      reader.mockRestore();
    }
  });
}

for (const state of ["article", "missing-or-hidden", "read-error"] as const) {
  test(`Help article preload uses the request viewer and locale: ${state}`, async () => {
    const { person } = await import("../_internal/define-app.test-fixture");
    const actor = { kind: "user", user: person } as const;
    const read = async (input: { appId: string; documentId: string }) => {
      expect(input).toEqual({ appId: "spaces", documentId: "share" });
      if (state === "read-error") throw new Error("Fixture article read failed");
      if (state === "missing-or-hidden") return null;
      return {
        appId: "spaces",
        appName: "Spaces",
        documentId: "share",
        title: "Share",
        locale: "de",
        order: 1,
        kind: "task" as const,
        needs: "edit" as const,
        manifestHash: "fixture",
        related: [],
        links: {},
        markdown: 'Teile einen Space.\n\n## Einladen {icon="share"}\n\n:kbd[mod+k]\n\n:::steps\n1. Öffnen.\n:::',
      };
    };
    const reader = spyOn(helpService, "createHelpReader").mockReturnValue({
      read,
      manifest: async () => null,
      list: async () => [],
      search: async () => [],
    });
    try {
      const response = await new Hono<AuthContext>()
        .get("/", async (c) => {
          c.set("user", person);
          c.set("actor", actor);
          return c.json(await preloadLayoutHelpArticle(c, "spaces", "share"));
        })
        .request("/", { headers: { "Accept-Language": "de", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
      expect(response.status).toBe(200);
      expect(reader).toHaveBeenCalledWith("de", actor);
      const result = await response.json();
      if (state === "article") {
        expect(result).toMatchObject({
          payload: { locale: "de", id: "share", needs: "edit", kind: "task" },
          parts: { lead: "<p>Teile einen Space.</p>", sections: [{ id: "einladen", label: "Einladen" }], steps: 1 },
        });
        expect("html" in result.payload).toBe(false);
        // The server splitter encodes the platform-specific ⌘ key as an HTML entity.
        expect(result.parts.body).toContain("&#x2318;");
        expect(result.parts.body).not.toContain("Teile einen Space.");
      } else expect(result).toBeNull();
    } finally {
      reader.mockRestore();
    }
  });
}
