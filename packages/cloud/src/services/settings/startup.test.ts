import { afterEach, expect, test } from "bun:test";
import { bindConnections, connections, hasConnections } from "../../runtime/connections";
import { bulkRead, listLegacyKeys, readStates } from "./store";

const previous = hasConnections() ? connections() : undefined;
afterEach(() => bindConnections(previous));

test("settings propagate missing startup before cache or decryption fallbacks", async () => {
  bindConnections(undefined);
  await expect(bulkRead(["app.url"])).rejects.toThrow("connections() used before platform start");
  await expect(readStates(["app.url"])).rejects.toThrow("connections() used before platform start");
  await expect(listLegacyKeys()).rejects.toThrow("connections() used before platform start");
});
