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

  test("writes the configuration and the digest that makes Compose recreate Filegate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dev-filegate-"));
    const prepare = async (appUrl: string) => {
      await prepareDevFilegate(directory, appUrl);
      const config = await readFile(join(directory, "conf.yaml"), "utf8");
      const digest = await readFile(join(directory, "conf.env"), "utf8");
      expect(digest).toBe(`FILEGATE_CONFIG_SHA256=${new Bun.CryptoHasher("sha256").update(config).digest("hex")}\n`);
      return { config, digest, token: await readFile(join(directory, "token"), "utf8") };
    };
    try {
      const publicOrigin = await prepare("https://cloud.dev.example");
      expect(publicOrigin.config).toContain(
        'allowed_origins: ["http://localhost:3000","http://127.0.0.1:3000","https://cloud.dev.example"]',
      );
      expect((await stat(join(directory, "token"))).mode & 0o777).toBe(0o600);

      // Repeated runs keep the digest, so Compose leaves a running Filegate alone.
      expect(await prepare("https://cloud.dev.example")).toEqual(publicOrigin);

      const localOrigin = await prepare("localhost:3000");
      expect(localOrigin.digest).not.toBe(publicOrigin.digest);
      expect(localOrigin.token).toBe(publicOrigin.token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(compose).toContain("filegate_config:\n    file: ./.local/filegate/conf.yaml\n");
    expect(compose).toContain("    env_file: ./.local/filegate/conf.env\n");
  });
});
