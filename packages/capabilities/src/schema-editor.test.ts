import { describe, expect, test } from "bun:test";
import { buildCapabilityInput, createSchemaEditorModel, createSchemaEditorState } from "./schema-editor";

describe("capability schema editor", () => {
  test("builds a typed request for a closed scalar object", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["email", "limit"],
      properties: {
        email: { type: "string", format: "email", title: "Email" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        includeArchived: { type: "boolean", default: true },
        mode: { type: "string", enum: ["fast", "complete"] },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
    };
    const model = createSchemaEditorModel(schema);
    expect(model.mode).toBe("form");
    const state = createSchemaEditorState(model, schema);
    state.values.email = "person@example.com";
    state.values.mode = JSON.stringify("complete");
    state.values.tags = "first\nsecond";

    expect(buildCapabilityInput(model, state)).toEqual({
      ok: true,
      input: {
        email: "person@example.com",
        limit: 10,
        includeArchived: true,
        mode: "complete",
        tags: ["first", "second"],
      },
    });
  });

  test("reports field errors before an invalid request is sent", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["email", "count"],
      properties: {
        email: { type: "string", format: "email" },
        count: { type: "integer", minimum: 2 },
      },
    };
    const model = createSchemaEditorModel(schema);
    const state = createSchemaEditorState(model, schema);
    state.values.email = "not-an-email";
    state.values.count = 1;
    const result = buildCapabilityInput(model, state);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["email", "count"]);
  });

  test("uses JSON for nested schemas and rejects non-object input", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { nested: { type: "object", properties: { value: { type: "string" } } } },
    };
    const model = createSchemaEditorModel(schema);
    expect(model.mode).toBe("json");
    const state = createSchemaEditorState(model, schema);
    state.source = "[]";

    expect(buildCapabilityInput(model, state)).toEqual({
      ok: false,
      errors: {},
      formError: "The request must be a JSON object.",
    });
  });

  test("localizes form guidance and validation with regional fallback", () => {
    const complex = createSchemaEditorModel({ type: "array" }, "de-CH");
    expect(complex).toMatchObject({ mode: "json", reason: "Dieses Schema ist zu komplex für das Formular. Gib die Anfrage als JSON ein." });
    expect(buildCapabilityInput(complex, { values: {}, source: "[]" }, "de-CH")).toMatchObject({
      ok: false,
      formError: "Die Anfrage muss ein JSON-Objekt sein.",
    });
  });

  test("keeps required empty strings and arrays valid when the schema allows them", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["query", "tags"],
      properties: {
        query: { type: "string", maxLength: 500 },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
    };
    const model = createSchemaEditorModel(schema);
    const state = createSchemaEditorState(model, schema);

    expect(buildCapabilityInput(model, state)).toEqual({
      ok: true,
      input: { query: "", tags: [] },
    });
  });

  test("omits empty optional constrained strings and validates required formats", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["bookId", "label"],
      properties: {
        bookId: { type: "string", format: "uuid" },
        label: { type: "string", minLength: 1 },
        phone: { type: "string", minLength: 1 },
      },
    };
    const model = createSchemaEditorModel(schema);
    const state = createSchemaEditorState(model, schema);
    const result = buildCapabilityInput(model, state);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ bookId: "Book Id must be a UUID.", label: "Label must contain at least 1 character." });
  });
});
