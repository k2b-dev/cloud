import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { MAX_INLINE_CREATES_PER_FIELD } from "../service/form-submission";
import { createAuthenticatedFormRoutes } from "./form-authenticated-routes";
import { createPublicFormRoutes } from "./form-public-routes";
import formsRoutes from "./forms";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const formId = "33333333-3333-4333-8333-333333333333";
const tablePublicId = "T4BL01";
const formPublicId = "F0RM01";

const form = {
  id: formId,
  shortId: formPublicId,
  tableId,
  name: "Intake",
  config: {
    title: "Public intake",
    fields: [
      { kind: "user_input", fieldId: "44444444-4444-4444-8444-444444444444" },
      { kind: "form_value", fieldId: "55555555-5555-4555-8555-555555555555", value: "secret" },
    ],
  },
  publicToken: "token",
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("public form routes", () => {
  test("rejects invalid retry keys before invoking the submission service", async () => {
    let calls = 0;
    const app = createPublicFormRoutes({
      getByPublicToken: async () => form as never,
      submit: async () => {
        calls += 1;
        return ok({ recordId: formId });
      },
    });
    for (const idempotencyKey of ["", " ", "x".repeat(201), "key\0bad"]) {
      const response = await app.request("/public/token/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: {}, idempotencyKey }),
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });
  test("keeps management routes behind parent auth", async () => {
    expect((await formsRoutes.request(`/by-table/${tableId}`)).status).toBe(401);
  });

  test("returns 404 for an unknown token", async () => {
    const app = createPublicFormRoutes({ getByPublicToken: async () => null });
    const response = await app.request("/public/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Form not found" });
  });

  test("returns only public render fields", async () => {
    const app = createPublicFormRoutes({
      getByPublicToken: async () => form as never,
      projectForm: async () => ({
        id: formPublicId,
        name: "Intake",
        config: { title: "Public intake", fields: [{ kind: "user_input", fieldId: "F1ELD1" }] },
      }),
    });
    const response = await app.request("/public/token");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: formPublicId,
      name: "Intake",
      config: {
        title: "Public intake",
        fields: [{ kind: "user_input", fieldId: "F1ELD1" }],
      },
    });
  });

  test("rejects oversized inline-create batches before invoking the service", async () => {
    let submitted = false;
    const app = createPublicFormRoutes({
      getByPublicToken: async () => form as never,
      dateConfig: () => ({ locale: "en", timeZone: "UTC" }),
      submit: async () => {
        submitted = true;
        return ok({ recordId: Bun.randomUUIDv7() });
      },
    });
    const drafts = Array.from({ length: MAX_INLINE_CREATES_PER_FIELD + 1 }, (_, index) => ({ tempId: `tmp_${index}`, data: {} }));
    const response = await app.request("/public/token/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: {}, inlineCreates: { [form.config.fields[0]!.fieldId]: drafts } }),
    });

    expect(response.status).toBe(400);
    expect(submitted).toBe(false);
  });
});

describe("authenticated form routes", () => {
  const service = {
    table: { get: async (id: string) => (id === tableId ? { id: tableId, baseId } : null) },
    form: {
      listForTable: async () => [form],
    },
  };
  const resolveId = async (_context: unknown, _name: string, type: string) => (type === "table" ? tableId : formId);

  test("returns 404 for an unknown table", async () => {
    const app = createAuthenticatedFormRoutes({ service: service as never, resolveId: async () => baseId });
    const response = await app.request(`/by-table/B4SE01`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Table not found" });
  });

  test("rejects an invalid table id before calling the service", async () => {
    let calls = 0;
    const app = createAuthenticatedFormRoutes({
      service: {
        ...service,
        table: {
          getByShortId: async () => {
            calls += 1;
            return null;
          },
        },
      } as never,
    });

    const response = await app.request("/by-table/not-an-id");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid table id" });
    expect(calls).toBe(0);
  });

  test("denies list access without table read", async () => {
    const app = createAuthenticatedFormRoutes({
      service: service as never,
      resolveId: resolveId as never,
      gate: async () => fail(err.forbidden("Forbidden")),
    });
    const response = await app.request(`/by-table/${tablePublicId}`);

    expect(response.status).toBe(403);
  });

  test("lists forms for a readable table", async () => {
    const app = createAuthenticatedFormRoutes({
      service: service as never,
      resolveId: resolveId as never,
      gate: async () => ok("read"),
      projectForms: async () => [
        {
          id: formPublicId,
          tableId: tablePublicId,
          name: form.name,
          config: { title: "Public intake", fields: [] },
          publicToken: form.publicToken,
          isActive: true,
          ownerUserId: null,
          position: 0,
          isDefault: false,
          deletedAt: null,
          createdAt: form.createdAt,
          updatedAt: form.updatedAt,
        },
      ],
    });
    const response = await app.request(`/by-table/${tablePublicId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ id: formPublicId, tableId: tablePublicId, name: "Intake" })]);
  });
});

test("filtered relation lookup keeps public tokens and Base grants as entry gates", async () => {
  const publicRoutes = createPublicFormRoutes({ getByPublicToken: async () => null });
  expect((await publicRoutes.request("/public/missing/relations/FIELD1/lookup")).status).toBe(404);
  expect((await formsRoutes.request("/FORM01/relations/FIELD1/lookup")).status).toBe(401);
});
