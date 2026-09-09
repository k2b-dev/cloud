import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";

const root = mkdtempSync(join(tmpdir(), "tools-page-route-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { createToolsPageRoutes } = await import("./index");
const { resolveRegistry } = await import("./tools/registry");
const { toolById } = resolveRegistry("en");

const pass: MiddlewareHandler<AuthContext> = async (_context, next) => next();
const routes = createToolsPageRoutes({
  requireAny: pass,
  requireAuthenticated: pass,
  toolsPage: [(context) => context.text("overview")],
  toolDetailPage: [(context) => context.json({ toolId: context.req.param("toolId") })],
});

describe("Tools page routes", () => {
  test("keeps the document Markdown id available to the shared detail page", async () => {
    const response = await routes.request("/document-markdown");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ toolId: "document-markdown" });
  });

  test("keeps the Markdown PDF id available to the shared detail page", async () => {
    const response = await routes.request("/markdown-pdf");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ toolId: "markdown-pdf" });
  });

  test("sends anonymous document Markdown users to login and back without restricting other tool pages", async () => {
    const protectedRoutes = new Hono<AuthContext>().route(
      "/tools",
      createToolsPageRoutes({
        requireAny: pass,
        toolsPage: [(context) => context.text("overview")],
        toolDetailPage: [(context) => context.json({ toolId: context.req.param("toolId") })],
      }),
    );

    const response = await protectedRoutes.request("http://cloud.local/tools/document-markdown");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login?redirectTo=%2Ftools%2Fdocument-markdown");
    const markdownPdf = await protectedRoutes.request("http://cloud.local/tools/markdown-pdf");
    expect(markdownPdf.status).toBe(302);
    expect(markdownPdf.headers.get("location")).toBe("/auth/login?redirectTo=%2Ftools%2Fmarkdown-pdf");
    expect((await protectedRoutes.request("http://cloud.local/tools/uuid")).status).toBe(200);
  });

  test("allows authenticated document Markdown requests through to the detail page", async () => {
    const authenticatedRoutes = createToolsPageRoutes({
      requireAny: pass,
      requireAuthenticated: pass,
      toolsPage: [(context) => context.text("overview")],
      toolDetailPage: [(context) => context.json({ toolId: context.req.param("toolId") })],
    });

    expect((await authenticatedRoutes.request("/document-markdown")).status).toBe(200);
  });

  test("uses the available Markdown icon throughout the Tools catalog", () => {
    expect(toolById("document-markdown")?.icon).toBe("ti ti-markdown");
    expect(toolById("markdown-pdf")?.icon).toBe("ti ti-file-type-pdf");
    expect(toolById("image-converter")?.icon).toBe("ti ti-arrows-exchange");
  });
});
