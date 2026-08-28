import { describe, expect, test } from "bun:test";
import { findStartupFailure } from "./dev-cli";

const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

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
    const command = packageJson.scripts["dev:down"];
    expect(command).toContain("compose.dev.yml");
    expect(command).not.toContain("--remove-orphans");
    expect(command).not.toContain("--volumes");
  });
});
