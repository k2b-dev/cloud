import { describe, expect, test } from "bun:test";

const compose = await Bun.file(new URL("../compose.prod.yml", import.meta.url)).text();

describe("production Compose release set", () => {
  test("isolates the OAuth broker secret to Core and OAuth in both stacks", async () => {
    for (const file of ["compose.dev.yml", "compose.prod.yml"]) {
      const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      const receivers: string[] = [];
      let service = "";
      for (const line of source.split(/\r?\n/)) {
        const match = /^  ([a-z][a-z0-9-]*):$/.exec(line);
        if (match) service = match[1]!;
        if (line.includes("CLOUD_OAUTH_BROKER_SECRET:")) {
          expect(line.startsWith("      CLOUD_OAUTH_BROKER_SECRET:")).toBeTrue();
          receivers.push(service);
          if (file === "compose.dev.yml") expect(line).toMatch(/:-[a-f0-9]{64}\}/);
          else expect(line).toContain("${CLOUD_OAUTH_BROKER_SECRET:?CLOUD_OAUTH_BROKER_SECRET is required}");
        }
      }
      expect(receivers).toEqual(["app-core", "app-oauth"]);
      expect(source).not.toContain("CLOUD_OAUTH_APP_CREDENTIAL");
      expect(source).toContain("CLOUD_MAIL_APP_CREDENTIAL");
    }
  });
  test("requires one immutable tag for every runtime image", () => {
    const images = compose
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("image: ghcr.io/k2b-dev/cloud-"));
    expect(images).toHaveLength(23);
    expect(images.some((line) => line.includes("/cloud-app-kit:"))).toBeTrue();
    expect(images.every((line) => line.endsWith(":${CLOUD_IMAGE_TAG:?CLOUD_IMAGE_TAG is required}"))).toBeTrue();
    expect(images.some((line) => /:(?:latest|main)$/.test(line))).toBeFalse();
  });
});
