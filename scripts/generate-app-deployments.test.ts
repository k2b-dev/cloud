import { expect, test } from "bun:test";
import { renderAppDeployment } from "./generate-app-deployments";
import { appIds, devServiceName } from "./workspace";

test("production and dev templates wire only app key and Core origin into every application", async () => {
  for (const development of [false, true]) {
    const name = `compose.${development ? "dev" : "prod"}.yml`;
    const rendered = renderAppDeployment(await Bun.file(new URL(`./templates/${name}`, import.meta.url)).text(), development);
    expect(rendered).toContain(development ? "explicit oauth:issue grant" : "keys create oauth --grant oauth:issue");
    expect(rendered).toBe(await Bun.file(new URL(`../${name}`, import.meta.url)).text());
    const parsed = Bun.YAML.parse(rendered) as {
      services: Record<
        string,
        { environment: Record<string, unknown>; secrets?: { source: string; target: string }[]; depends_on?: Record<string, unknown> }
      >;
      secrets: Record<string, { file: string }>;
    };
    for (const id of appIds()) {
      const service = parsed.services[devServiceName(id)]!;
      if (id === "core" || id === "gateway") {
        expect(service.environment.DATABASE_URL).toBeDefined();
        expect(service.environment.CLOUD_APP_KEY_FILE).toBeUndefined();
        continue;
      }
      expect(service.environment.CLOUD_APP_KEY_FILE).toBe(`/run/secrets/${id}.key`);
      expect(service.environment.CLOUD_CORE_INTERNAL_ORIGIN).toBe("http://app-core:3000");
      for (const key of ["DATABASE_URL", "REDIS_URL", "NATS_SERVERS", "APP_SECRET", "CLOUD_OAUTH_BROKER_SECRET"])
        expect(service.environment[key]).toBeUndefined();
      expect(service.secrets).toEqual([{ source: `${id}-app-key`, target: `${id}.key` }]);
      const mountedKey = service.secrets?.find((secret) => `/run/secrets/${secret.target}` === service.environment.CLOUD_APP_KEY_FILE);
      expect(mountedKey).toBeDefined();
      expect(parsed.secrets[mountedKey!.source]?.file).toBeDefined();
      expect(service.depends_on?.["app-core"]).toEqual({ condition: "service_healthy" });
      expect(parsed.secrets[`${id}-app-key`]?.file).toBe(`./${development ? ".local/dev-app-keys" : "secrets"}/${id}.key`);
    }
  }
});

test("app-owned development environment survives generation", async () => {
  const source = await Bun.file(new URL("./templates/compose.dev.yml", import.meta.url)).text();
  const rendered = renderAppDeployment(source, true);
  expect(rendered).toContain("      CLOUD_CLI_CHROMIUM: /usr/bin/chromium");
  expect(rendered).toContain("      NATS_ADMIN_NKEY_SEED_FILE: /run/secrets/nats-admin.seed");
  expect(() => renderAppDeployment(source.replace("      CLOUD_CLI_CHROMIUM:", "      CLOUD_APP_KEY:"), true)).toThrow("generator-owned");
});
