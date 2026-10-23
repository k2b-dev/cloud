import { afterAll, beforeAll } from "bun:test";
import { testInfra } from "../../../../../scripts/fixtures/test-infra";
import { appRegistry } from "../../_internal/registry";
import type { AppAccessRule } from "../../contracts/app-access";

/** A directly mounted integration router still represents a registered application. */
export const useRegisteredTestApp = (appId: string, access?: AppAccessRule): void => {
  let registered = false;
  beforeAll(async () => {
    if (!testInfra.nats || !testInfra.database) return;
    await appRegistry().upsert({
      key: `apps/${appId}`,
      value: {
        id: appId,
        name: appId,
        icon: "ti ti-test-pipe",
        description: "Integration fixture",
        baseUrl: `http://${appId}.test:3000`,
        routes: [`/api/${appId}`],
        ...(access ? { access } : {}),
      },
    });
    registered = true;
  });
  afterAll(async () => {
    if (registered) await appRegistry().delete({ key: `apps/${appId}` });
  });
};
