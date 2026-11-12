import { CapabilityAppIdSchema } from "../../contracts/capabilities";
import { SecretRotationStatusSchema } from "../../contracts/secret-status";
import { command, flag, printStructured } from "../index";
import { apiGet } from "./shared";

export const secretCommands = [
  command("secrets status", {
    summary: "Inspect APP_SECRET overlap and automatic ciphertext rewrap",
    flags: {
      strict: flag.boolean({ description: "Exit 1 until every expected instance and owner is ready" }),
      expect: flag.string({ description: "Comma-separated application inventory; Core and Gateway are always included" }),
    },
    async run({ ctx, flags }) {
      try {
        const expect = (flags.expect ?? "").split(/[\s,]+/).filter(Boolean);
        if (expect.some((app) => !CapabilityAppIdSchema.safeParse(app).success))
          throw new Error("--expect requires comma-separated app IDs");
        const query = new URLSearchParams(expect.length ? { expect: expect.join(",") } : {});
        const result = SecretRotationStatusSchema.parse(await apiGet(ctx, `/api/admin/secrets/status${query.size ? `?${query}` : ""}`));
        if (!printStructured(ctx, result)) {
          ctx.print(`Secret rotation: ${result.ready ? "ready" : "not ready"}; current=${result.current ?? "unknown or mixed"}`);
          for (const app of result.apps) {
            for (const instance of app.instances) {
              const ring = instance.secrets;
              ctx.print(
                `${app.appId}/${instance.instanceId}: current=${ring?.current ?? "unknown"}, previous=${ring?.previous ?? "none"}, next=${ring?.next ?? "none"}`,
              );
              for (const owner of ring?.owners ?? [])
                ctx.print(
                  `  ${owner.id}: rows=${owner.rows}, previousOnly=${owner.previousOnly}, unreadable=${owner.unreadable}, checkedAt=${owner.checkedAt ?? "pending"}`,
                );
            }
            for (const reason of app.reasons) ctx.print(`${app.appId}: ${reason}`);
          }
          for (const issue of result.registryIssues) ctx.print(`${issue.key}: ${issue.reason}`);
        }
        return flags.strict && !result.ready ? 1 : 0;
      } catch (error) {
        ctx.error(error instanceof Error ? error.message : "Secret status failed");
        return 2;
      }
    },
  }),
];
