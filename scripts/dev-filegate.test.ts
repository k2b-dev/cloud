import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devFilegateAllowedOrigins, prepareDevFilegate } from "./dev-filegate";

const compose = await Bun.file(new URL("../compose.yml", import.meta.url)).text();

describe("development Filegate", () => {
  test("allows the local gateway and the configured public app origin", () => {
    expect(devFilegateAllowedOrigins("https://cloud.dev.example/")).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://cloud.dev.example",
    ]);
    expect(devFilegateAllowedOrigins("cloud.dev.example")).toContain("https://cloud.dev.example");
  });

  test("keeps only the local origins for the default app URL", () => {
    const local = ["http://localhost:3000", "http://127.0.0.1:3000"];
    expect(devFilegateAllowedOrigins("localhost:3000")).toEqual(local);
    expect(devFilegateAllowedOrigins("")).toEqual(local);
  });

  test("writes the configuration Compose mounts and reports changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dev-filegate-"));
    try {
      expect(await prepareDevFilegate(directory, "https://cloud.dev.example")).toBeTrue();
      const config = await readFile(join(directory, "conf.yaml"), "utf8");
      expect(config).toContain('allowed_origins: ["http://localhost:3000","http://127.0.0.1:3000","https://cloud.dev.example"]');
      const token = await readFile(join(directory, "token"), "utf8");
      expect((await stat(join(directory, "token"))).mode & 0o777).toBe(0o600);

      expect(await prepareDevFilegate(directory, "https://cloud.dev.example")).toBeFalse();
      expect(await prepareDevFilegate(directory, "localhost:3000")).toBeTrue();
      expect(await readFile(join(directory, "token"), "utf8")).toBe(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(compose).toContain("filegate_config:\n    file: ./.local/filegate/conf.yaml\n");
  });
});
