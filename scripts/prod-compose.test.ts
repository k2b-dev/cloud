import { describe, expect, test } from "bun:test";
import { appIds } from "./workspace";

const compose = await Bun.file(new URL("../compose.prod.yml", import.meta.url)).text();

describe("production Compose release set", () => {
  test("ordinary production apps receive their enrolled identity and Core origin", () => {
    const parsed = Bun.YAML.parse(compose) as { services: Record<string, { environment: Record<string, string> }> };
    for (const id of appIds().filter((id) => id !== "core" && id !== "gateway")) {
      const service = parsed.services[`app-${id}`]!;
      expect(Object.keys(service.environment).sort()).toEqual(["CLOUD_APP_KEY_FILE", "CLOUD_CORE_INTERNAL_ORIGIN"]);
      expect(service.environment.CLOUD_APP_KEY_FILE).toBe(`/run/secrets/${id}.key`);
    }
  });
  test("preserves the gateway host admission and private ingress listener", () => {
    const gateway = compose.split("  gateway:\n")[1]?.split("  app-gateway-ops:")[0];
    expect(gateway).toContain('aliases: ["cloud-gateway-${CLOUD_HOST}"]');
    expect(gateway).toContain("APP_URL: https://${CLOUD_HOST}");
    expect(gateway).toContain("GATEWAY_INTERNAL_URL: http://cloud-gateway-${CLOUD_HOST}:3000");
    expect(gateway).toContain('expose: ["3001"]');
  });
  test("requires one immutable tag for every runtime image", () => {
    const images = compose
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("image: ghcr.io/k2b-dev/cloud-"));
    expect(images).toHaveLength(appIds().length);
    expect(images.some((line) => line.includes("/cloud-app-filesv2:"))).toBeTrue();
    expect(images.some((line) => line.includes("/cloud-app-pulse:"))).toBeTrue();
    expect(images.every((line) => line.endsWith(":${CLOUD_IMAGE_TAG:?CLOUD_IMAGE_TAG is required}"))).toBeTrue();
    expect(images.some((line) => /:(?:latest|main)$/.test(line))).toBeFalse();
  });
  test.each(["app-pwa", "app-chat"])("starts the unreleased %s only with its profile", (name) => {
    const service = new RegExp(`^  ${name}:\\n((?: {4}.*\\n)*)`, "m").exec(compose)?.[1];
    expect(service).toContain('    profiles: ["unreleased"]\n');
  });
});
