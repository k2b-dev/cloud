import { expect, test } from "bun:test";
import { parse } from "yaml";
import { z } from "zod";
import { appIds, devServiceName, httpAppIds, releaseImages } from "../../../scripts/workspace";

const Compose = z.object({
  services: z.record(
    z.string(),
    z
      .object({
        environment: z.unknown().optional(),
        networks: z.unknown().optional(),
        container_name: z.string().optional(),
        ports: z.array(z.unknown()).optional(),
        mem_limit: z.string().optional(),
        stop_grace_period: z.string().optional(),
      })
      .passthrough(),
  ),
  networks: z.record(z.string(), z.unknown()),
});

test("runner has an application image and both Compose templates isolate its network and environment", async () => {
  expect(appIds()).toContain("runner");
  expect(httpAppIds()).not.toContain("runner");
  expect(httpAppIds()).toContain("core");
  expect(devServiceName("runner")).toBe("runner");
  expect(releaseImages().find((image) => image.appId === "runner")).toEqual({
    image: "cloud-app-runner",
    dockerfile: "packages/runner/Dockerfile",
    appId: "runner",
  });
  for (const file of ["compose.dev.yml", "compose.prod.yml"]) {
    const compose = Compose.parse(parse(await Bun.file(`${import.meta.dir}/../../../${file}`).text()));
    const runner = compose.services.runner!;
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(runner.environment)).sort()).toEqual([
      "CLOUD_APP_KEY_FILE",
      "CLOUD_CORE_INTERNAL_ORIGIN",
    ]);
    expect(runner.environment).toEqual({
      CLOUD_APP_KEY_FILE: "/run/runner-key/source",
      CLOUD_CORE_INTERNAL_ORIGIN: "http://app-core:3000",
    });
    expect(runner.secrets).toEqual([{ source: "runner-app-key", target: "/run/runner-key/source" }]);
    expect(runner.cap_drop).toEqual(["ALL"]);
    expect(runner.cap_add).toEqual(["SETUID", "SETGID", "KILL", "CHOWN", "DAC_OVERRIDE"]);
    expect(runner.security_opt).toEqual(["no-new-privileges:true"]);
    expect(runner.pid).toBeUndefined();
    expect(runner.read_only).toBe(true);
    expect(runner.tmpfs).toEqual(["/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777"]);
    expect(runner.container_name).toBeUndefined();
    expect(runner.ports).toBeUndefined();
    expect(runner.mem_limit).toBe("1g");
    expect(runner.stop_grace_period).toBe("6m");
    expect(runner.networks).toEqual(["runner-core"]);
    expect(compose.networks["runner-core"]).toEqual({ internal: true });
    expect(compose.services["app-core"]!.networks).toContain("runner-core");
    expect(
      Object.entries(compose.services)
        .filter(([, service]) => z.array(z.string()).safeParse(service.networks).data?.includes("runner-core"))
        .map(([name]) => name)
        .sort(),
    ).toEqual(["app-core", "runner"]);
  }
});
