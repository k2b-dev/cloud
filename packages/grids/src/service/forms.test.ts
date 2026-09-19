import { describe, expect, test } from "bun:test";
import { type Form, normalizeFormConfig, toPublicRenderableForm, toRenderableForm } from "./forms";
import { materializeFormRenderDefaults } from "./form-render-defaults";
import type { Field } from "./types";

const form = (): Form => ({
  id: "00000000-0000-0000-0000-000000000001",
  shortId: "abc12",
  tableId: "00000000-0000-0000-0000-000000000002",
  name: "Contact",
  config: {
    title: "Contact us",
    fields: [
      { kind: "user_input", fieldId: "00000000-0000-0000-0000-000000000003", label: "Email" },
      {
        kind: "user_input",
        fieldId: "00000000-0000-0000-0000-000000000006",
        label: "Company",
        inlineCreate: {
          enabled: true,
          fields: [{ fieldId: "00000000-0000-0000-0000-000000000007", label: "Company name", required: true }],
        },
      },
      { kind: "form_value", fieldId: "00000000-0000-0000-0000-000000000004", value: "website" },
    ],
    successMessage: "Thanks",
  },
  publicToken: "secret-token",
  isActive: true,
  ownerUserId: "00000000-0000-0000-0000-000000000005",
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("form render DTOs", () => {
  test("renders date defaults once in request timezone without changing authored values", () => {
    const source = form();
    const field: Field = { id: "Date01", shortId: "Date01", tableId: source.tableId, name: "Date", type: "date",
      config: {}, description: null, position: 0, required: false, defaultValue: null,
      presentable: false, hideInTable: false, indexed: false, uniqueConstraint: false,
      createdAt: source.createdAt, updatedAt: source.updatedAt, deletedAt: null };
    source.config.fields = [
      { kind: "user_input", fieldId: field.id, defaultValue: { kind: "now" } },
      { kind: "form_value", fieldId: field.id, value: { kind: "now" } },
    ];
    const rendered = materializeFormRenderDefaults(source, [field], {
      dateConfig: { timeZone: "Europe/Berlin" }, now: new Date("2026-09-14T23:30:00Z"),
    });
    expect(rendered.config.fields[0]).toMatchObject({ defaultValue: "2026-09-15" });
    expect(source.config.fields[0]).toMatchObject({ defaultValue: { kind: "now" } });
    expect(rendered.config.fields[1]).toBe(source.config.fields[1]);
    expect(materializeFormRenderDefaults(rendered, [field], {
      now: new Date("2026-09-20T23:30:00Z"),
    }).config.fields[0]).toEqual(rendered.config.fields[0]);
  });
  test("raw config normalization preserves valid cross-field rules and ignores malformed ones", () => {
    expect(
      normalizeFormConfig({
        fields: [],
        validations: [
          {
            leftFieldId: "00000000-0000-4000-8000-000000000003",
            operator: "lte",
            rightFieldId: "00000000-0000-4000-8000-000000000006",
            message: "Start must precede Due.",
          },
          { operator: "javascript" },
        ],
      }).validations,
    ).toEqual([
      {
        leftFieldId: "00000000-0000-4000-8000-000000000003",
        operator: "lte",
        rightFieldId: "00000000-0000-4000-8000-000000000006",
        message: "Start must precede Due.",
      },
    ]);
  });

  test("raw config normalization preserves inline relation create settings", () => {
    expect(
      normalizeFormConfig({
        fields: [
          {
            kind: "user_input",
            fieldId: "00000000-0000-0000-0000-000000000006",
            label: "Company",
            inlineCreate: {
              enabled: true,
              fields: [
                {
                  fieldId: "00000000-0000-0000-0000-000000000007",
                  label: "Company name",
                  helpText: "Shown on invoices.",
                  required: true,
                },
              ],
            },
          },
        ],
      }).fields,
    ).toEqual([
      {
        kind: "user_input",
        fieldId: "00000000-0000-0000-0000-000000000006",
        label: "Company",
        inlineCreate: {
          enabled: true,
          fields: [
            {
              fieldId: "00000000-0000-0000-0000-000000000007",
              label: "Company name",
              helpText: "Shown on invoices.",
              required: true,
            },
          ],
        },
      },
    ]);
  });

  test("strip server-applied values from authenticated render forms", () => {
    const dto = toRenderableForm(form());

    expect(dto.publicToken).toBe(null);
    expect(dto.ownerUserId).toBe(null);
    expect(dto.config.fields).toEqual([
      { kind: "user_input", fieldId: "00000000-0000-0000-0000-000000000003", label: "Email" },
      {
        kind: "user_input",
        fieldId: "00000000-0000-0000-0000-000000000006",
        label: "Company",
        inlineCreate: {
          enabled: true,
          fields: [{ fieldId: "00000000-0000-0000-0000-000000000007", label: "Company name", required: true }],
        },
      },
    ]);
  });

  test("public render forms expose only the minimal anonymous shape", () => {
    const dto = toPublicRenderableForm(form());

    expect(Object.keys(dto).sort()).toEqual(["config", "id", "name"]);
    expect(dto.config.fields).toEqual([
      { kind: "user_input", fieldId: "00000000-0000-0000-0000-000000000003", label: "Email" },
      {
        kind: "user_input",
        fieldId: "00000000-0000-0000-0000-000000000006",
        label: "Company",
        inlineCreate: {
          enabled: true,
          fields: [{ fieldId: "00000000-0000-0000-0000-000000000007", label: "Company name", required: true }],
        },
      },
    ]);
  });
});

test("relation filters survive persisted configuration normalization and fail closed when malformed", () => {
  const config = {
    fields: [
      {
        kind: "user_input",
        fieldId: "00000000-0000-0000-0000-000000000003",
        relationFilter: {
          op: "AND",
          filters: [{ fieldId: "00000000-0000-0000-0000-000000000007", op: "=", value: true }],
        },
      },
    ],
  };
  expect(normalizeFormConfig(config).fields[0]).toMatchObject(config.fields[0]!);
  expect(() => normalizeFormConfig({ fields: [{ ...config.fields[0], relationFilter: { op: "AND", filters: "invalid" } }] })).toThrow();
});
