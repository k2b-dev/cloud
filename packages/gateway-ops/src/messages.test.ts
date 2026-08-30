import { expect, test } from "bun:test";
import { gatewayOpsApiErrorMessage, gatewayOpsMessages } from "./messages";

test("Gateway operations messages contain matching locale contracts", () => {
  expect(gatewayOpsMessages.check()).toEqual([]);
});

test("Gateway API messages isolate concurrent request locales", async () => {
  const [english, german] = await Promise.all([
    Promise.resolve().then(() => gatewayOpsApiErrorMessage(500, "en")),
    Promise.resolve().then(() => gatewayOpsApiErrorMessage(500, "de-CH")),
  ]);
  expect(english).toBe("The Gateway operation failed");
  expect(german).toBe("Der Gateway-Vorgang ist fehlgeschlagen");
});
