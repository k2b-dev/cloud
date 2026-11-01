import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import { sql } from "../../runtime/clients";
import { audit } from "../audit";
import { settingsService } from "./app";
import * as budget from "./geo-budget";
import * as settings from "./index";
import * as store from "./store";

useUnitClients();
const tx = Object.assign(new SQL("postgres://127.0.0.1:1/unused_test"), {
  savepoint: () => {
    throw new Error("Unexpected savepoint");
  },
});
afterAll(() => tx.close());
afterEach(() => mock.restore());

test("audited settings validate the final budget, write and audit in one transaction, then invalidate", async () => {
  const order: string[] = [];
  spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(tx);
    order.push("commit");
  });
  const validate = spyOn(budget, "assertGeoBudgetPair").mockImplementation(async () => {
    order.push("validate");
  });
  const write = spyOn(settings, "set").mockImplementation(async () => {
    order.push("write");
  });
  const record = spyOn(audit, "record").mockImplementation(async () => {
    order.push("audit");
  });
  const invalidate = spyOn(store, "invalidateSettingsCache").mockImplementation(async () => {
    order.push("invalidate");
  });
  const event = { action: "settings.update", outcome: "allowed" as const, target: { type: "setting", id: "app.name" } };
  expect((await settingsService.entry.update({ key: "app.name", value: "Fixture", audit: event })).ok).toBe(true);
  expect(order).toEqual(["validate", "write", "audit", "commit", "invalidate"]);
  expect(validate).toHaveBeenCalledWith(tx, { "app.name": "Fixture" }, []);
  expect(write).toHaveBeenCalledWith("app.name", "Fixture", tx, { replaceUnreadable: undefined });
  expect(record).toHaveBeenCalledWith(event, tx);
  order.length = 0;
  record.mockRejectedValue(new Error("audit unavailable"));
  expect((await settingsService.entry.update({ key: "app.name", value: "Fixture", audit: event })).ok).toBe(false);
  expect(order).toEqual(["validate", "write"]);
  expect(invalidate).toHaveBeenCalledTimes(1);
});
