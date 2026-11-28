import { expect, test } from "bun:test";
import type { RuntimeAppMeta } from "@k2b/cloud/contracts";
import { adminStart } from "./start";

const core = { id: "core", name: "Cloud", icon: "ti ti-cloud", description: "Core", routes: ["/", "/admin"] } satisfies RuntimeAppMeta;
const gatewayOps = {
  id: "gateway-ops",
  name: "Gateway",
  icon: "ti ti-route",
  description: "Gateway",
  routes: ["/admin/observability"],
} satisfies RuntimeAppMeta;

test("/admin opens the operations overview where Gateway Ops serves it, and Apps without it, with the old link's parameters", () => {
  expect(adminStart([core, gatewayOps], "http://cloud.test/admin")).toBe("/admin/observability");
  expect(adminStart([core, gatewayOps], "http://cloud.test/admin?from=mail&locale=de")).toBe("/admin/observability?from=mail&locale=de");
  expect(adminStart([core], "http://cloud.test/admin")).toBe("/admin/apps");
  expect(adminStart([core], "http://cloud.test/admin?from=mail")).toBe("/admin/apps?from=mail");
});
