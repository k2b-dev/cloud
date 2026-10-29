import { expect, test } from "bun:test";
import { app } from "./config";

test("Pulse stays in the app menu without becoming a default rail app", () => {
  expect(app.meta.nav).toMatchObject({
    href: "/app/pulse",
    match: "/app/pulse",
    section: "more",
    requiresAuth: true,
    requiresRoles: ["user"],
  });
});
