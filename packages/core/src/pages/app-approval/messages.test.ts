import { expect, test } from "bun:test";
import { appApprovalMessages } from "./messages";

test("app approval UI has complete English and German messages", () => {
  expect(appApprovalMessages.check()).toEqual([]);
  expect(appApprovalMessages.resolve(["de-CH"]).t.pair).toBe("Gerät koppeln");
});
