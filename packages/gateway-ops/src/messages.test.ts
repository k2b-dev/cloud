import { expect, test } from "bun:test";
import { gatewayOpsMessages } from "./messages";

test("Gateway operations messages contain matching locale contracts", () => {
  expect(gatewayOpsMessages.check()).toEqual([]);
});
