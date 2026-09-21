import { describe, expect, test } from "bun:test";
import { findStartupFailure } from "./dev-cli";

const downScript = await Bun.file(new URL("./dev-down.ts", import.meta.url)).text();

describe("development startup diagnostics", () => {
  test("returns the latest actionable failure without a Compose prefix", () => {
    expect(findStartupFailure("app-core | booting\napp-core | error: browser build failed\napp-core | waiting")).toBe(
      "error: browser build failed",
    );
  });

  test("falls back to the latest log line", () => {
    expect(findStartupFailure("app-core | booting\napp-core | waiting")).toBe("waiting");
  });

  test("keeps separately composed infrastructure when removing the app stack", () => {
    expect(downScript).toContain("COMPOSE_FILE} --profile extra down");
    expect(downScript).not.toContain("--remove-orphans");
    expect(downScript).not.toContain("--volumes");
    expect(downScript).toContain('inputs.includes("--infra")');
  });
});
