import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertBothReplicasServed,
  composeEnvironment,
  dockerEnvironment,
  envFileContents,
  HELP,
  parseOptions,
  type Replica,
  SCALED_APPS,
} from "./scale-acceptance";
import { appIds } from "./workspace";

describe("scale acceptance configuration", () => {
  test("parses only supported arguments", () => {
    expect(parseOptions([])).toEqual({ help: false, imageTag: undefined, replicas: 2 });
    expect(parseOptions(["--image-tag", "sha-abc123", "--replicas", "1"]).replicas).toBe(1);
    expect(parseOptions(["--image-tag", "sha-abc123"]).imageTag).toBe("sha-abc123");
    expect(parseOptions(["--help"]).help).toBe(true);
    for (const args of [
      ["--replicas", "0"],
      ["--replicas", "3"],
      ["--replicas", "1.0"],
      ["--image-tag", "bad/tag"],
      ["--image-tag", ""],
      ["--keep"],
      ["positional"],
    ])
      expect(() => parseOptions(args)).toThrow();
  });
  test("help exits without a heavy slot or Docker", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/scale-acceptance.ts", "--help"], {
      env: { PATH: "", CLOUD_HEAVY_SLOTS: "invalid" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(output).toBe(HELP + "\n");
    for (const option of ["--help", "--image-tag", "--replicas"]) expect(output).toContain(option);
  });
  test("Compose values are fresh and cannot inherit the shell", () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, {
        APP_SECRET: "inherited-secret",
        POSTGRES_PASSWORD: "inherited-password",
        CLOUD_IMAGE_TAG: "inherited-tag",
        CLOUD_HOST: "production.example",
        COMPOSE_FILE: "foreign.yml",
        SCALE_ENV_SENTINEL: "never-copy-this",
      });
      const env = composeEnvironment("scale-test", "deadbeef");
      const contents = envFileContents(env);
      expect(env.CLOUD_IMAGE_TAG).toBe("scale-test");
      expect(env.CLOUD_HOST).toBe("cloud.scale-acceptance.test");
      expect(env.POSTGRES_DB).toEndWith("_test");
      expect(env.SYNC_NAMESPACE).toBe("scale-deadbeef");
      for (const value of [
        "inherited-secret",
        "inherited-password",
        "inherited-tag",
        "production.example",
        "foreign.yml",
        "never-copy-this",
      ])
        expect(contents).not.toContain(value);
      expect(composeEnvironment("scale-test", "deadbeef").APP_SECRET).not.toBe(env.APP_SECRET);
      // Cover every interpolation variable, including optional settings of apps we do not boot.
      const production = readFileSync(new URL("../compose.prod.yml", import.meta.url), "utf8");
      for (const [, key] of production.matchAll(/\$\{([A-Z_]+)/g)) expect(env).toHaveProperty(key!);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });
  test("Docker gets only its minimal client environment", () => {
    const allowed = {
      PATH: "/bin",
      HOME: "/tmp/home",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      DOCKER_CONFIG: "/tmp/docker",
      DOCKER_CONTEXT: "test",
    };
    expect(
      dockerEnvironment({
        ...allowed,
        APP_SECRET: "secret",
        COMPOSE_PROJECT_NAME: "dev",
        COMPOSE_PROFILES: "all",
        POSTGRES_DB: "dev",
        BUN_OPTIONS: "--env-file=.env",
        NODE_ENV: "production",
      }),
    ).toEqual(allowed);
    expect(dockerEnvironment({})).toEqual({});
  });
  test("selected apps and gateway belong to this workspace", () => {
    for (const app of ["gateway", ...SCALED_APPS]) expect(appIds()).toContain(app);
    expect(SCALED_APPS).toEqual(["core", "mail", "chat", "notebooks"]);
  });
});

const a: Replica = { id: "container-a", ip: "172.20.0.2", url: "http://127.0.0.1:40001", number: 1 };
const b: Replica = { id: "container-b", ip: "172.20.0.3", url: "http://127.0.0.1:40002", number: 2 };
describe("both-replicas-served guard", () => {
  test("passes only distinct, running, served replicas", () => {
    expect(() => assertBothReplicasServed("app-chat", { a, b, served: new Set([a.id, b.id]) }, new Set([a.id, b.id]))).not.toThrow();
  });
  test("rejects the single-replica negative control even if recorded twice", () => {
    expect(() => assertBothReplicasServed("app-chat", { a, b: a, served: new Set([a.id, a.id]) }, new Set([a.id]))).toThrow(
      "replica B is the same container as replica A; the cross-replica run would be vacuous",
    );
  });
  test("rejects an unserved replica", () => {
    expect(() => assertBothReplicasServed("app-chat", { a, b, served: new Set([a.id]) }, new Set([a.id, b.id]))).toThrow(
      "served no scenario step",
    );
  });
  test("rejects shared IPs and stopped replicas", () => {
    expect(() =>
      assertBothReplicasServed("app-chat", { a, b: { ...b, ip: a.ip }, served: new Set([a.id, b.id]) }, new Set([a.id, b.id])),
    ).toThrow("different internal IPs");
    expect(() => assertBothReplicasServed("app-chat", { a, b, served: new Set([a.id, b.id]) }, new Set([a.id]))).toThrow(
      "no longer running",
    );
  });
  test("only the explicitly killed Core may be stopped", () => {
    const evidence = { a, b, served: new Set([a.id, b.id]) };
    expect(() => assertBothReplicasServed("app-core", evidence, new Set([b.id]), a.id)).not.toThrow();
    expect(() => assertBothReplicasServed("app-core", evidence, new Set(), a.id)).toThrow("no longer running");
  });
});
