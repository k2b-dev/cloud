import { afterEach, expect, test } from "bun:test";
import { bindConnections, connections, hasConnections } from "../../runtime/connections";
import { registerSettings } from "./defaults";
import { readEnvSettingsStatus } from "./env-status";
import { bulkRead, listLegacyKeys, readStates } from "./store";

const previous = hasConnections() ? connections() : undefined;
afterEach(() => bindConnections(previous));

test("settings propagate missing startup before cache or decryption fallbacks", async () => {
  bindConnections(undefined);
  await expect(bulkRead(["app.url"])).rejects.toThrow("connections() used before platform start");
  await expect(readStates(["app.url"])).rejects.toThrow("connections() used before platform start");
  await expect(listLegacyKeys()).rejects.toThrow("connections() used before platform start");
});

test("bound settings and environment status propagate missing startup", async () => {
  const owner = "test.startup_servers";
  const access = "test.startup_access";
  registerSettings([
    {
      key: owner,
      kind: "string_list",
      default: [],
      group: "test",
      description: "Startup binding probe",
      resetOnChange: [access],
      envBootstrap: () => [],
    },
    { key: access, kind: "secret", default: "", group: "test", description: "Startup binding access probe" },
  ]);
  bindConnections(undefined);
  await expect(bulkRead([access])).rejects.toThrow("connections() used before platform start");
  await expect(readStates([access])).rejects.toThrow("connections() used before platform start");
  await expect(readEnvSettingsStatus()).rejects.toThrow("connections() used before platform start");
});
