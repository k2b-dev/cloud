import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthContext, REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import * as pageData from "./[baseId]/page-data";

const root = mkdtempSync(join(tmpdir(), "pulse-workspace-page-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: basePage } = await import("./[baseId]/page");

test("workspace SSR keeps its raised timeout while loading workspace data and restores it after failure", async () => {
  const timeouts: number[] = [];
  const failure = new Error("fixture load failure");
  const load = spyOn(pageData, "loadPulseWorkspacePageData").mockImplementation(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(timeouts).toEqual([60]);
    throw failure;
  });
  const app = new Hono<AuthContext>().get("/:baseId/sources", ...basePage);
  app.onError((error, c) => {
    expect(error).toBe(failure);
    return c.text("fixture failure", 500);
  });
  try {
    const response = await app.request("/Base01/sources", {}, { timeout: (_request: Request, seconds: number) => timeouts.push(seconds) });
    expect(response.status).toBe(500);
    expect(timeouts).toEqual([60, REQUEST_IDLE_TIMEOUT_SECONDS]);
  } finally {
    load.mockRestore();
  }
});
