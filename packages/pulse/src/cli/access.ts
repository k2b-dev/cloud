import { createAccessCommands } from "@k2b/cloud/cli";
import type { AccessEntry, PermissionLevel, Principal } from "@k2b/cloud/contracts";
import { resolveBaseFromCommand } from "./context";
import { compactId, jsonRequest, readApi } from "./shared";
import type { MessageResult } from "./types";

export const pulseAccessCommands = createAccessCommands({
  resourceLabel: "Pulse base",
  resourceArgLabel: "base",
  resourceArgDescription: "Optional Pulse base id or exact name. If omitted, the default from `cld pulse use` is used.",
  resolveResource: async (ctx, args) => {
    const { base } = await resolveBaseFromCommand(ctx, args, 0);
    return {
      id: base.id,
      label: `${base.name} (${compactId(base.id)})`,
    };
  },
  list: async (ctx, base) => readApi<AccessEntry[]>(ctx, `/bases/${encodeURIComponent(base.id)}/access`),
  grant: async (ctx, base, principal: Principal, permission: PermissionLevel) =>
    readApi<AccessEntry>(ctx, `/bases/${encodeURIComponent(base.id)}/access`, jsonRequest("POST", { principal, permission })),
  update: async (ctx, base, accessId, permission) => {
    await readApi<MessageResult>(
      ctx,
      `/bases/${encodeURIComponent(base.id)}/access/${encodeURIComponent(accessId)}`,
      jsonRequest("PATCH", { permission }),
    );
  },
  revoke: async (ctx, base, accessId) => {
    await readApi<MessageResult>(
      ctx,
      `/bases/${encodeURIComponent(base.id)}/access/${encodeURIComponent(accessId)}`,
      jsonRequest("DELETE"),
    );
  },
  examples: {
    list: ['cld pulse access list "Ops telemetry"', "cld pulse access list --base Base01"],
    grant: [
      'cld pulse access grant "Ops telemetry" --user valentin.kolb --permission read',
      'cld pulse access grant "Ops telemetry" --group "Sysadmins" --permission admin',
      'cld pulse access grant "Ops telemetry" --authenticated --permission read',
    ],
    set: [
      'cld pulse access set "Ops telemetry" --group "Sysadmins" --permission write',
      "cld pulse access set --base Base01 --access-id 00000000-0000-4000-8000-000000000000 --permission admin",
    ],
    revoke: [
      'cld pulse access revoke "Ops telemetry" --user valentin.kolb --yes',
      "cld pulse access revoke --base Base01 --access-id 00000000-0000-4000-8000-000000000000 --yes",
    ],
    searchPrincipals: [
      "cld pulse access search-principals val --kind user,group",
      'cld pulse access search-principals "Sysadmins" --kind group',
    ],
  },
});
