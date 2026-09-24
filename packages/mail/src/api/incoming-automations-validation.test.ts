import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import incomingAutomationRoutes from "./incoming-automations";
import type { MailApiContext } from "./public-resource-boundary";

const app = () =>
  new Hono<MailApiContext>()
    .use(async (c, next) => {
      c.set("internalMailboxId", "00000000-0000-4000-8000-000000000001");
      await next();
    })
    .route("/", incomingAutomationRoutes);

const step = { id: "11111111-1111-4111-8111-111111111111", kind: "mail_action", action: { kind: "trash" } };
const condition = { field: "sender_address", operator: "is", value: "user@example.com" };

const create = (body: unknown, locale = "en") =>
  app().request("/mailboxes/Mbx123/incoming-automations", {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": locale },
    body: JSON.stringify(body),
  });

describe("Mail incoming automation validation errors", () => {
  test("name the offending field with a localized message and structured issues", async () => {
    const response = await create({
      name: "Trash",
      scope: { mode: "matching", conditions: { mode: "all", conditions: [condition] } },
      steps: [step],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string; issues: unknown[] };
    expect(body.code).toBe("BAD_INPUT");
    expect(body.message).toBe("Invalid incoming automation definition: scope.conditions.items: Required. Expected a list. (+1 more)");
    expect(body.issues).toEqual([
      { field: "scope.conditions.items", code: "invalid_type", message: "Required. Expected a list." },
      { field: "scope.conditions.conditions", code: "unrecognized_keys", message: "Unknown field." },
    ]);
  });

  test("uses the request locale for issue messages", async () => {
    const response = await create({ name: "Trash", scope: { mode: "matching", conditions: [condition] }, steps: [step] }, "de");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "BAD_INPUT",
      message: "Ungültige Automatisierung: scope.conditions: Erwartet wird ein Objekt, erhalten: eine Liste.",
      issues: [{ field: "scope.conditions", code: "invalid_type", message: "Erwartet wird ein Objekt, erhalten: eine Liste." }],
    });
  });
});
