import { expect, test } from "bun:test";
import { Hono } from "hono";
import { SettingUnreadableError } from "./store";

test("SettingUnreadableError retains its 409 and JSON recovery code through Hono", async () => {
  const error = new SettingUnreadableError("test.probe");
  const app = new Hono().put("/", () => {
    throw error;
  });
  const response = await app.request("/", { method: "PUT" });
  expect(response.status).toBe(409);
  expect(error.key).toBe("test.probe");
  expect(await response.json()).toEqual({ code: "setting_unreadable", message: error.message });
  expect(error.message).toContain('setting "test.probe"');
});
