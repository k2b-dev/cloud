import { expect, setSystemTime, test } from "bun:test";
import { app as core } from "../packages/core/src/config";
import { buildAppRoutesDetailed } from "../packages/gateway/src/routes";
import { buildRouteTable, matchRoute } from "../packages/gateway/src/trie";
import { app as operations } from "../packages/gateway-ops/src/config";

test("Core's principal inbox and notification administration keep their declared gateway owners", () => {
  setSystemTime(new Date("2030-03-14T08:00:00Z"));
  try {
    const { routes, warnings } = buildAppRoutesDetailed(
      [core.meta, operations.meta].map((meta) => ({ ...meta, baseUrl: `http://${meta.id}:3000`, startedAt: 0 })),
    );
    expect(warnings).toEqual([]);
    const table = buildRouteTable(routes);
    expect(matchRoute(table, "/api/notifications/inbox")?.appId).toBe("core");
    for (const path of [
      "/api/notifications",
      "/api/notifications/deliveries",
      "/api/notifications/summary",
      "/api/notifications/pending-system",
    ])
      expect(matchRoute(table, path)?.appId).toBe("gateway-ops");
  } finally {
    setSystemTime();
  }
});
