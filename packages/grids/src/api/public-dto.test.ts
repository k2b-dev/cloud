import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { field } from "../query-dsl/resolver-fixtures";
import * as publicResources from "../service/public-resources";
import {
  fromPublicFieldWrite,
  fromPublicUpdateTable,
  fromPublicUpdateView,
  PublicCreateFieldSchema,
  PublicFederatedDraftInputSchema,
  PublicFederatedRevisionViewSchema,
  PublicFederatedSourcePublicationSchema,
  PublicFieldSchema,
  PublicFormSchema,
  PublicMutationPolicyImpactSchema,
  PublicMutationPolicyInputSchema,
  PublicMutationPolicyUpdateSchema,
  PublicTableQueryResponseSchema,
  PublicTableSchema,
  PublicUpdateTableSchema,
  PublicUpdateViewSchema,
  PublicViewSchema,
  publicFieldKey,
  resourceTypeForKnownIdKey,
  toPublicTableQueryResponse,
} from "./public-dto";

const now = "2026-08-15T00:00:00.000Z";
const uuid = "11111111-1111-4111-8111-111111111111";

describe("Grids public DTO ID boundary", () => {
  test("omits deleted field UUID keys without hiding computed aliases", () => {
    const activeFieldId = "22222222-2222-4222-8222-222222222222";
    expect(publicFieldKey(new Map([[activeFieldId, "FILD01"]]), activeFieldId)).toBe("FILD01");
    expect(publicFieldKey(new Map(), uuid)).toBeNull();
    expect(publicFieldKey(new Map(), "computed_total")).toBe("computed_total");
  });

  test("recognizes nested resource ID keys in public configurations", () => {
    expect(
      ["fieldId", "fieldIds", "imageFieldId", "dateFieldId", "leftFieldId", "rightFieldId", "errorFieldId", "relationFieldId"].map(
        resourceTypeForKnownIdKey,
      ),
    ).toEqual(Array(8).fill("field"));
    expect(["tableId", "sourceTableIds", "recordId", "selectedRecordId", "viewId", "formId"].map(resourceTypeForKnownIdKey)).toEqual([
      "table",
      "table",
      "record",
      "record",
      "view",
      "form",
    ]);
    expect(["baseId", "fileId", "ownerUserId", "identityProviderId"].map(resourceTypeForKnownIdKey)).toEqual([null, null, null, null]);
  });

  test("models the virtual default form without inventing a public resource id", () => {
    const projected = PublicFormSchema.parse({
      tableId: "TABL01",
      name: "Default",
      config: { fields: [] },
      publicToken: null,
      isActive: true,
      ownerUserId: null,
      position: 0,
      isDefault: true,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(projected).not.toHaveProperty("id");
  });
  test("table schemas reject nested UUID field references", () => {
    const table = {
      id: "TABL01",
      baseId: "BASE01",
      kind: "stored",
      name: "Items",
      description: null,
      columns: [{ fieldId: "FILD01" }],
      displayConfig: { mode: "cards", cards: { imageFieldId: "FILD01", fieldIds: ["FILD01"] } },
      auditPolicy: {},
      mutationPolicy: { mode: "all" },
      position: 0,
      disableDirectInsert: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(PublicTableSchema.safeParse(table).success).toBe(true);
    expect(PublicTableSchema.safeParse({ ...table, columns: [{ fieldId: uuid }] }).success).toBe(false);
    expect(PublicTableSchema.safeParse({ ...table, displayConfig: { mode: "cards", cards: { imageFieldId: uuid } } }).success).toBe(false);
    expect(PublicUpdateTableSchema.safeParse({ columns: [{ fieldId: "FILD01" }] }).success).toBe(true);
    expect(PublicUpdateTableSchema.safeParse({ columns: [{ fieldId: uuid }] }).success).toBe(false);
    expect(PublicUpdateTableSchema.safeParse({ auditPolicy: { update: { fieldIds: [uuid] } } }).success).toBe(false);
  });

  test("mutation policy inputs and impact use only the bounded public contract", () => {
    expect(PublicMutationPolicyInputSchema.parse({ policy: { mode: "selected", sources: ["form", "workflow"] } })).toEqual({
      policy: { mode: "selected", sources: ["form", "workflow"] },
    });
    expect(PublicMutationPolicyInputSchema.safeParse({ policy: { mode: "selected", sources: ["form", "form"] } }).success).toBe(false);
    expect(PublicMutationPolicyUpdateSchema.safeParse({ policy: { mode: "selected", sources: [] } }).success).toBe(false);
    expect(PublicMutationPolicyUpdateSchema.safeParse({ policy: { mode: "selected", sources: [] }, confirmFreeze: true }).success).toBe(
      true,
    );
    expect(
      PublicMutationPolicyImpactSchema.safeParse({
        items: [{ kind: "workflow", id: "WORK01", name: "Notify owners" }],
        total: 1,
        limit: 50,
        truncated: false,
        complete: true,
      }).success,
    ).toBe(true);
    expect(
      PublicMutationPolicyImpactSchema.safeParse({
        items: [{ kind: "workflow", id: uuid, name: "Internal UUID leak" }],
        total: 1,
        limit: 50,
        truncated: false,
        complete: true,
      }).success,
    ).toBe(false);
  });

  test("view and form schemas reject nested UUID field references", () => {
    const view = {
      id: "VIEW01",
      tableId: "TABL01",
      name: "All items",
      description: null,
      source: "from Items",
      ui: { columns: [{ fieldId: "FILD01" }] },
      ownerUserId: null,
      position: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(PublicViewSchema.safeParse(view).success).toBe(true);
    expect(PublicViewSchema.safeParse({ ...view, ui: { columns: [{ fieldId: uuid }] } }).success).toBe(false);
    expect(PublicUpdateViewSchema.safeParse({ ui: { columns: [{ fieldId: "FILD01" }] } }).success).toBe(true);
    expect(PublicUpdateViewSchema.safeParse({ ui: { groupedColumnOrder: [`group:0:${uuid}:year`] } }).success).toBe(false);

    const form = {
      id: "FORM01",
      tableId: "TABL01",
      name: "Create item",
      config: { fields: [{ kind: "user_input", fieldId: "FILD01" }] },
      publicToken: null,
      isActive: true,
      ownerUserId: null,
      position: 0,
      isDefault: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(PublicFormSchema.safeParse(form).success).toBe(true);
    expect(PublicFormSchema.safeParse({ ...form, config: { fields: [{ kind: "user_input", fieldId: uuid }] } }).success).toBe(false);
  });

  test("resolves every table and view presentation field through the owning table", async () => {
    const fieldId = "22222222-2222-4222-8222-222222222222";
    const field = {
      id: fieldId,
      shortId: "FILD01",
      tableId: uuid,
      name: "Name",
      description: null,
      icon: null,
      type: "text",
      config: {},
      position: 0,
      required: false,
      presentable: true,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const listFields = async () => [field];
    const table = await fromPublicUpdateTable(
      uuid,
      {
        columns: [{ fieldId: "FILD01" }],
        displayConfig: { mode: "cards", cards: { imageFieldId: "FILD01", fieldIds: ["FILD01"] } },
        auditPolicy: { update: { enabled: false, questions: [], scope: "selected", fieldIds: ["FILD01"] } },
      },
      { listFields },
    );
    expect(table).toMatchObject({
      ok: true,
      data: {
        columns: [{ fieldId }],
        displayConfig: { cards: { imageFieldId: fieldId, fieldIds: [fieldId] } },
        auditPolicy: { update: { fieldIds: [fieldId] } },
      },
    });

    const view = await fromPublicUpdateView(
      uuid,
      {
        ui: {
          columns: [{ fieldId: "FILD01" }],
          displayConfig: { mode: "calendar", calendar: { dateFieldId: "FILD01" } },
          groupedColumnOrder: ["group:0:FILD01:year", "agg:0:FILD01:sum"],
          hiddenGroupedColumns: ["agg:1:*:count"],
        },
      },
      { listFields },
    );
    expect(view).toMatchObject({
      ok: true,
      data: {
        ui: {
          columns: [{ fieldId }],
          displayConfig: { calendar: { dateFieldId: fieldId } },
          groupedColumnOrder: [`group:0:${fieldId}:year`, `agg:0:${fieldId}:sum`],
          hiddenGroupedColumns: ["agg:1:*:count"],
        },
      },
    });
    expect(await fromPublicUpdateView(uuid, { ui: { columns: [{ fieldId: "MISS01" }] } }, { listFields })).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
  });

  test("field schemas reject UUIDs in typed config and relation defaults", async () => {
    const relation = {
      id: "FILD01",
      tableId: "TABL01",
      name: "Owner",
      description: null,
      type: "relation",
      config: { targetTableId: "TABL02", cardinality: "single" },
      position: 0,
      required: false,
      presentable: false,
      hideInTable: false,
      defaultValue: ["RECD01"],
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(PublicFieldSchema.safeParse(relation).success).toBe(true);
    expect(PublicFieldSchema.safeParse({ ...relation, config: { targetTableId: uuid } }).success).toBe(false);
    expect(PublicFieldSchema.safeParse({ ...relation, defaultValue: [uuid] }).success).toBe(false);
    expect(PublicCreateFieldSchema.safeParse({ name: "Owner", type: "lookup", config: { relationFieldId: uuid } }).success).toBe(false);
    expect((await fromPublicFieldWrite("relation", { config: { targetTableId: uuid } })).ok).toBe(false);
    expect(await fromPublicFieldWrite("relation", { name: "Renamed" })).toEqual({ ok: true, data: { name: "Renamed" } });
  });

  test("federation schemas expose resource references only as public ids", () => {
    const draft = {
      sourceTableIds: ["TABL02"],
      mappings: [{ targetFieldId: "FILD01", sourceTableId: "TABL02", sourceFieldId: "FILD02", config: {} }],
    };
    expect(PublicFederatedDraftInputSchema.safeParse(draft).success).toBe(true);
    expect(PublicFederatedDraftInputSchema.safeParse({ ...draft, sourceTableIds: [uuid] }).success).toBe(false);
    expect(PublicFederatedDraftInputSchema.safeParse({ ...draft, mappings: [{ ...draft.mappings[0], targetFieldId: uuid }] }).success).toBe(
      false,
    );
    expect(PublicFederatedDraftInputSchema.safeParse({ ...draft, retainedSourceIds: [uuid] }).success).toBe(false);

    const revision = {
      tableId: "TABL01",
      revision: 1,
      status: "draft",
      diagnostics: [{ code: "bad_mapping", message: "Bad mapping", sourceFieldId: "FILD02" }],
      revisionToken: "token",
      createdBy: null,
      publishedBy: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      sources: [{ sourceTableId: "TABL02", position: 0, authorizedAt: null, revokedAt: null }],
      mappings: draft.mappings,
    };
    expect(PublicFederatedRevisionViewSchema.safeParse(revision).success).toBe(true);
    expect(PublicFederatedRevisionViewSchema.safeParse({ ...revision, tableId: uuid }).success).toBe(false);
    expect(
      PublicFederatedRevisionViewSchema.safeParse({ ...revision, diagnostics: [{ code: "bad", message: "Bad", sourceFieldId: uuid }] })
        .success,
    ).toBe(false);
    expect(PublicFederatedRevisionViewSchema.safeParse({ ...revision, id: uuid }).success).toBe(false);
    expect(PublicFederatedRevisionViewSchema.safeParse({ ...revision, sources: [{ ...revision.sources[0], id: uuid }] }).success).toBe(
      false,
    );

    const publication = {
      targetBaseId: "BASE01",
      targetBaseName: "Inventory",
      targetTableId: "TABL01",
      targetTableName: "Items",
      revision: 1,
      status: "active",
      publishedAt: now,
      revokedAt: null,
      mappings: [
        {
          sourceFieldId: "FILD02",
          sourceFieldName: "Title",
          targetFieldId: "FILD01",
          targetFieldName: "Name",
          targetFieldType: "text",
        },
      ],
    };
    expect(PublicFederatedSourcePublicationSchema.safeParse(publication).success).toBe(true);
    expect(PublicFederatedSourcePublicationSchema.safeParse({ ...publication, targetTableId: uuid }).success).toBe(false);
    expect(PublicFederatedSourcePublicationSchema.safeParse({ ...publication, targetTableShortId: "TABL01" }).success).toBe(false);
  });
});

describe("Grids public query envelope", () => {
  const relationFieldId = "22222222-2222-4222-8222-222222222222";
  const ownerFieldId = "33333333-3333-4333-8333-333333333333";
  const recordId = "44444444-4444-4444-8444-444444444444";
  const linkedId = "55555555-5555-4555-8555-555555555555";
  const userId = "66666666-6666-4666-8666-666666666666";
  const groupId = "77777777-7777-4777-8777-777777777777";
  const fields = [
    field({ id: relationFieldId, shortId: "RELATE", name: "Customer", type: "relation", config: { targetTableId: uuid } }),
    field({ id: ownerFieldId, shortId: "OWNERS", name: "Owners", type: "principal" }),
  ];
  const owners = [
    { type: "user", id: userId },
    { type: "group", id: groupId },
  ];
  const response = {
    items: [
      {
        id: recordId,
        shortId: "RECD01",
        tableId: uuid,
        data: { [relationFieldId]: [linkedId], [ownerFieldId]: owners },
        version: 1,
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    nextCursor: null,
    relationLabels: { [linkedId]: "Acme", [userId]: "Ada Example", [groupId]: "Support" },
  };
  const publicIds = new Map([
    [uuid, "TABL01"],
    [linkedId, "LINK01"],
  ]);
  let projectPublicIds: ReturnType<typeof spyOn>;
  beforeEach(() => {
    projectPublicIds = spyOn(publicResources, "projectPublicIds").mockImplementation(
      async (_type, ids) => new Map(ids.flatMap((id) => (publicIds.has(id) ? [[id, publicIds.get(id)!] as const] : []))),
    );
  });
  afterEach(() => projectPublicIds.mockRestore());

  test("keeps People-and-groups labels under the account IDs the record data already shows", async () => {
    const projected = await toPublicTableQueryResponse(response, fields);

    expect(projected.items?.[0]?.data).toEqual({ RELATE: ["LINK01"], OWNERS: owners });
    expect(projected.relationLabels).toEqual({ LINK01: "Acme", [userId]: "Ada Example", [groupId]: "Support" });
    expect(PublicTableQueryResponseSchema.safeParse(projected).success).toBe(true);
  });

  test("still refuses a label that neither a record nor a shown principal owns", async () => {
    const unknownId = "88888888-8888-4888-8888-888888888888";
    await expect(
      toPublicTableQueryResponse({ ...response, relationLabels: { ...response.relationLabels, [unknownId]: "Hidden" } }, fields),
    ).rejects.toThrow("Missing public ID for record");
  });
});
