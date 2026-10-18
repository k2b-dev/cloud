import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDevClickhouse } from "./dev-clickhouse";

test("local credentials are private, created once and never replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-clickhouse-fixture-"));
  try {
    await prepareDevClickhouse(directory);
    const admin = await readFile(join(directory, "credentials.env"), "utf8");
    const service = await readFile(join(directory, "pulse_service.password"), "utf8");
    expect(/^CLICKHOUSE_USER=pulse_admin\nCLICKHOUSE_PASSWORD=[a-f0-9]{64}\nCLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1\n$/.test(admin)).toBe(
      true,
    );
    expect(/^[a-f0-9]{64}\n$/.test(service)).toBe(true);
    // Replace with obvious fake fixtures before testing persistence, so failures cannot print generated credentials.
    await writeFile(join(directory, "credentials.env"), "CLICKHOUSE_PASSWORD=obviously-fake-admin-password\n");
    await writeFile(join(directory, "pulse_service.password"), "obviously-fake-service-password\n");
    await prepareDevClickhouse(directory);
    expect(await readFile(join(directory, "credentials.env"), "utf8")).toBe("CLICKHOUSE_PASSWORD=obviously-fake-admin-password\n");
    expect(await readFile(join(directory, "pulse_service.password"), "utf8")).toBe("obviously-fake-service-password\n");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "credentials.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "pulse_service.password"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
