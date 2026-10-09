import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";

// Compile the pages' islands like the render tests do, so they share one module cache.
const root = mkdtempSync(join(tmpdir(), "cloud-help-access-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { createPagesRouter } = await import("../create");

test("Help pages send anonymous visitors to sign-in without content", async () => {
  const pages = createPagesRouter();
  for (const path of ["/help/apps/grids", "/help/apps/grids/grids-permissions"]) {
    const response = await pages.request(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("/auth/login");
    expect(await response.text()).toBe("");
  }
});
