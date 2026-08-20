import { describe, expect, test } from "bun:test";
import { filterDeclaredServices } from "./dev-cli";

const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
const composeDev = await Bun.file(new URL("../compose.dev.yml", import.meta.url)).text();
const restartScript = await Bun.file(new URL("./dev-restart.ts", import.meta.url)).text();

describe("development restart contract", () => {
  test("runs app containers without default file watchers", () => {
    expect(composeDev).not.toContain("--watch");
  });

  test("exposes a no-build restart command", () => {
    expect(packageJson.scripts["dev:restart"]).toBe("bun run scripts/dev-restart.ts");
    expect(restartScript).toContain('["--no-build", "--force-recreate"]');
    expect(restartScript).toContain('const restartRunning = inputs[0] === "--running"');
    expect(restartScript).toContain("services.map((service) => [service])");
  });

  test("excludes infrastructure containers from the running app set", () => {
    expect(filterDeclaredServices(["app-core", "postgres", "gateway", "valkey"], ["gateway", "app-core"])).toEqual(["app-core", "gateway"]);
  });
});
