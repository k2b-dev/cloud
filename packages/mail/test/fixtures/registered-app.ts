import { afterAll, beforeAll } from "bun:test";
import { appRegistry } from "@k2b/cloud";
import { testInfra } from "../../../../scripts/fixtures/test-infra";

/** A directly mounted Mail integration router still needs application registration. */
export const useRegisteredMailTestApp = (): void => {
  let registered = false;
  beforeAll(async () => {
    if (!testInfra.nats || !testInfra.database) return;
    await appRegistry().upsert({
      key: "apps/mail",
      value: {
        id: "mail",
        name: "mail",
        icon: "ti ti-test-pipe",
        description: "Mail integration fixture",
        baseUrl: "http://mail.test:3000",
        routes: ["/api/mail"],
      },
    });
    registered = true;
  });
  afterAll(async () => {
    if (registered) await appRegistry().delete({ key: "apps/mail" });
  });
};
