import { describe, expect, test } from "bun:test";
import type { Field } from "../contracts";
import type { Form } from "../service/forms";
import type { CustomAppCapabilities, CustomAppFormValueBinding } from "./contracts";
import { customAppFormFieldHash, customAppFormSecurityHash } from "./form-capability";
import { customAppFormMatchesPublishedCapability } from "./form-runtime";

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const tableId = uuid(1);
const parentTableId = uuid(2);
const textFieldId = uuid(3);
const relationFieldId = uuid(4);
const formId = uuid(5);

const fixedValues: Record<string, CustomAppFormValueBinding> = {
  [relationFieldId]: { source: "PARAMS", path: "parent_id" },
};
const bindingTableIds = new Map([[relationFieldId, parentTableId]]);
const form = {
  id: formId,
  tableId,
  isActive: true,
  config: {
    fields: [
      { kind: "user_input", fieldId: textFieldId },
      { kind: "user_input", fieldId: relationFieldId },
    ],
  },
} as Form;
const capability: CustomAppCapabilities["forms"][number] = {
  pageId: "create",
  blockId: "create",
  formId,
  tableId,
  userInputFieldIds: [relationFieldId, textFieldId].sort(),
  fixedFieldIds: [relationFieldId],
  fieldHash: "",
  formSecurityHash: "",
};
const fields = [
  { id: textFieldId, tableId, type: "text", config: {}, required: false, defaultValue: null, deletedAt: null },
  {
    id: relationFieldId,
    tableId,
    type: "relation",
    config: { targetTableId: parentTableId },
    required: false,
    defaultValue: null,
    deletedAt: null,
  },
] as Field[];
capability.fieldHash = customAppFormFieldHash([relationFieldId, textFieldId], fields);
capability.formSecurityHash = customAppFormSecurityHash({ tableId, config: form.config, fields });

describe("Grids App Form runtime capability", () => {
  test("accepts the exact published Form and relation binding", () => {
    expect(
      customAppFormMatchesPublishedCapability({ fixedValues, bindingTableIds, form, fields, inlineTargetFields: [], capability }),
    ).toBe(true);
  });

  test("requires resolved binding table identities for both parameter and page-record relations", () => {
    for (const binding of [
      { source: "PARAMS", path: "parent_id" },
      { source: "RECORD", path: "id" },
    ] as const) {
      for (const target of [undefined, "Parent", uuid(99), parentTableId]) {
        expect(
          customAppFormMatchesPublishedCapability({
            fixedValues: { [relationFieldId]: binding },
            bindingTableIds: target ? new Map([[relationFieldId, target]]) : new Map(),
            form,
            fields,
            inlineTargetFields: [],
            capability,
          }),
        ).toBe(target === parentTableId);
      }
    }
  });

  test("does not accept public fixed-field keys in the resolved capability comparison", () => {
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues: { Parent: { source: "PARAMS", path: "parent_id" } },
        bindingTableIds: new Map([["Parent", parentTableId]]),
        form,
        fields,
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(false);
  });

  test("accepts typed literals and the compatible page record as trusted values", () => {
    const literalValues: Record<string, CustomAppFormValueBinding> = {
      [textFieldId]: { source: "LITERAL", value: "Prepared" },
    };
    const literalCapability = { ...capability, fixedFieldIds: [textFieldId] };
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues: literalValues,
        bindingTableIds,
        form,
        fields,
        inlineTargetFields: [],
        capability: literalCapability,
      }),
    ).toBe(true);
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues: { [textFieldId]: { source: "LITERAL", value: { invalid: true } } },
        bindingTableIds,
        form,
        fields,
        inlineTargetFields: [],
        capability: literalCapability,
      }),
    ).toBe(false);

    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues: { [relationFieldId]: { source: "RECORD", path: "id" } },
        bindingTableIds,
        form,
        fields,
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(true);
  });

  test("accepts the current user only for principal fields in page-independent sidebar Forms", () => {
    const principalField = {
      ...fields[0]!,
      id: uuid(6),
      type: "principal",
      config: { cardinality: "single" },
    } as Field;
    const sidebarForm = {
      ...form,
      config: { fields: [{ kind: "user_input" as const, fieldId: principalField.id }] },
    };
    const sidebarValues: Record<string, CustomAppFormValueBinding> = {
      [principalField.id]: { source: "AUTH", path: "currentUser" },
    };
    const sidebarCapability: CustomAppCapabilities["forms"][number] = {
      sidebarActionId: "new-request",
      formId,
      tableId,
      userInputFieldIds: [principalField.id],
      fixedFieldIds: [principalField.id],
      fieldHash: customAppFormFieldHash([principalField.id], [principalField]),
      formSecurityHash: customAppFormSecurityHash({ tableId, config: sidebarForm.config, fields: [principalField] }),
    };

    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues: sidebarValues,
        bindingTableIds: new Map(),
        form: sidebarForm,
        fields: [principalField],
        inlineTargetFields: [],
        capability: sidebarCapability,
      }),
    ).toBe(true);
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues: sidebarValues,
        bindingTableIds: new Map(),
        form: sidebarForm,
        fields: [{ ...principalField, type: "text" }],
        inlineTargetFields: [],
        capability: {
          ...sidebarCapability,
          fieldHash: customAppFormFieldHash([principalField.id], [{ ...principalField, type: "text" }]),
          formSecurityHash: customAppFormSecurityHash({
            tableId,
            config: sidebarForm.config,
            fields: [{ ...principalField, type: "text" }],
          }),
        },
      }),
    ).toBe(false);
  });

  test("fails closed when fields or relation targets drift after publish", () => {
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form,
        fields: fields.slice(1),
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(false);
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form,
        fields: [fields[0]!, { ...fields[1]!, config: { targetTableId: uuid(99) } }],
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(false);
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form,
        fields: [{ ...fields[0]!, type: "number" }, fields[1]!],
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(false);
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form,
        fields: [fields[0]!, { ...fields[1]!, deletedAt: "2026-08-10T00:00:00.000Z" }],
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(false);
  });

  test("fails closed when a live Form adds a server-managed write", () => {
    const driftedForm = {
      ...form,
      config: {
        ...form.config,
        fields: [...form.config.fields, { kind: "form_value" as const, fieldId: uuid(99), value: "injected" }],
      },
    };
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form: driftedForm,
        fields,
        inlineTargetFields: [],
        capability,
      }),
    ).toBe(false);
  });

  test("pins inline-create declarations and target field schemas", () => {
    const targetField = {
      id: uuid(20),
      tableId: parentTableId,
      type: "text",
      config: { maxLength: 100 },
      required: true,
      defaultValue: null,
      deletedAt: null,
    } as unknown as Field;
    const inlineForm = {
      ...form,
      config: {
        fields: [
          {
            kind: "user_input" as const,
            fieldId: relationFieldId,
            inlineCreate: { enabled: true, fields: [{ fieldId: targetField.id, required: true }] },
          },
        ],
      },
    };
    const inlineCapability = {
      ...capability,
      userInputFieldIds: [relationFieldId],
      fieldHash: customAppFormFieldHash([relationFieldId], [fields[1]!]),
      formSecurityHash: customAppFormSecurityHash({
        tableId,
        config: inlineForm.config,
        fields: [fields[1]!, targetField],
      }),
    };
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form: inlineForm,
        fields: [fields[1]!],
        inlineTargetFields: [targetField],
        capability: inlineCapability,
      }),
    ).toBe(true);
    expect(
      customAppFormMatchesPublishedCapability({
        fixedValues,
        bindingTableIds,
        form: inlineForm,
        fields: [fields[1]!],
        inlineTargetFields: [{ ...targetField, config: { maxLength: 500 } }],
        capability: inlineCapability,
      }),
    ).toBe(false);
  });

  test("keeps field and config ordering out of the published hash", () => {
    expect(
      customAppFormFieldHash(
        [textFieldId, relationFieldId],
        [{ ...fields[1]!, config: { z: [1, { b: true, a: false }], targetTableId: parentTableId } }, fields[0]!],
      ),
    ).toBe(
      customAppFormFieldHash(
        [relationFieldId, textFieldId],
        [fields[0]!, { ...fields[1]!, config: { targetTableId: parentTableId, z: [1, { a: false, b: true }] } }],
      ),
    );
  });

  test("pins cross-field validation in the published Form security hash", () => {
    const left = { ...fields[0]!, id: uuid(30), type: "number" };
    const right = { ...fields[0]!, id: uuid(31), type: "number" };
    const config = {
      fields: [
        { kind: "user_input" as const, fieldId: left.id },
        { kind: "user_input" as const, fieldId: right.id },
      ],
      validations: [{ leftFieldId: left.id, operator: "lte" as const, rightFieldId: right.id, message: "Left must not exceed Right." }],
    };
    expect(customAppFormSecurityHash({ tableId, config, fields: [left, right] })).not.toBe(
      customAppFormSecurityHash({
        tableId,
        config: { ...config, validations: [{ ...config.validations[0]!, operator: "gte" }] },
        fields: [left, right],
      }),
    );
  });
});
