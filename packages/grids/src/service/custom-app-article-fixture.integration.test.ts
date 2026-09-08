import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { customAppFormFieldHash, customAppFormSecurityHash } from "../custom-apps/form-capability";
import { customAppViewSourceHash } from "../custom-apps/insight-source";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess, listCustomAppAccess } from "./access";
import { apply, compile, get, plan, publish } from "./custom-apps";

const ARTICLE = {
  appPublicId: "a00101",
  baseId: "20000000-0000-4000-8000-000000000001",
  basePublicId: "a00001",
  listTableId: "20000000-0000-4000-8000-000000000201",
  articleTableId: "20000000-0000-4000-8000-000000000202",
  listNameFieldId: "20000000-0000-4000-8000-000000000301",
  articleListFieldId: "20000000-0000-4000-8000-000000000302",
  articleNameFieldId: "20000000-0000-4000-8000-000000000303",
  articleWeightFieldId: "20000000-0000-4000-8000-000000000304",
  articleDescriptionFieldId: "20000000-0000-4000-8000-000000000305",
  listViewId: "20000000-0000-4000-8000-000000000401",
  articleFormId: "20000000-0000-4000-8000-000000000501",
  contributorGroupId: "20000000-0000-4000-8000-000000000701",
  responsibleGroupId: "20000000-0000-4000-8000-000000000702",
} as const;

const articleDefinitionPath = `${import.meta.dir}/../../docs/custom-apps/article-entry.yaml`;

const loadArticleDefinition = async () => CustomAppDefinitionSchema.parse(Bun.YAML.parse(await Bun.file(articleDefinitionPath).text()));

const cleanupArticleFixture = async (): Promise<void> => {
  await sql`DELETE FROM grids.bases WHERE id = ${ARTICLE.baseId}::uuid`;
  await sql`
    DELETE FROM auth.access
    WHERE group_id IN (${ARTICLE.contributorGroupId}::uuid, ${ARTICLE.responsibleGroupId}::uuid)
  `;
  await sql`
    DELETE FROM auth.groups
    WHERE id IN (${ARTICLE.contributorGroupId}::uuid, ${ARTICLE.responsibleGroupId}::uuid)
  `;
};

const insertArticleResources = async (): Promise<void> => {
  await sql`
    INSERT INTO auth.groups (id, cn, provider, name) VALUES
      (${ARTICLE.contributorGroupId}::uuid, 'custom-app-article-contributors', 'local', 'Article contributors'),
      (${ARTICLE.responsibleGroupId}::uuid, 'custom-app-article-responsible', 'local', 'Article responsible')
  `;
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${ARTICLE.baseId}::uuid, 'a00001', 'Article descriptions')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
      (${ARTICLE.listTableId}::uuid, 'a00201', ${ARTICLE.baseId}::uuid, 'Lists', 0),
      (${ARTICLE.articleTableId}::uuid, 'a00202', ${ARTICLE.baseId}::uuid, 'Articles', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES
      (${ARTICLE.listNameFieldId}::uuid, 'a00301', ${ARTICLE.listTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
      (
        ${ARTICLE.articleListFieldId}::uuid,
        'a00302',
        ${ARTICLE.articleTableId}::uuid,
        'List',
        'relation',
        ${{ targetTableId: ARTICLE.listTableId, cardinality: "single" }}::jsonb,
        0
      ),
      (${ARTICLE.articleNameFieldId}::uuid, 'a00303', ${ARTICLE.articleTableId}::uuid, 'Name', 'text', '{}'::jsonb, 1),
      (${ARTICLE.articleWeightFieldId}::uuid, 'a00304', ${ARTICLE.articleTableId}::uuid, 'Weight', 'number', '{}'::jsonb, 2),
      (${ARTICLE.articleDescriptionFieldId}::uuid, 'a00305', ${ARTICLE.articleTableId}::uuid, 'Description', 'longtext', '{}'::jsonb, 3)
  `;
  await sql`
    INSERT INTO grids.views (id, short_id, table_id, name, source)
    VALUES (
      ${ARTICLE.listViewId}::uuid,
      'a00401',
      ${ARTICLE.listTableId}::uuid,
      'Description lists',
      ${`from table {a00201}`}
    )
  `;
  await sql`
    INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
    VALUES (
      ${ARTICLE.articleFormId}::uuid,
      'a00501',
      ${ARTICLE.articleTableId}::uuid,
      'Add article',
      ${JSON.stringify({
        title: "Add article",
        submitLabel: "Add another",
        fields: [
          ARTICLE.articleListFieldId,
          ARTICLE.articleNameFieldId,
          ARTICLE.articleWeightFieldId,
          ARTICLE.articleDescriptionFieldId,
        ].map((fieldId) => ({ kind: "user_input", fieldId })),
      })}::jsonb,
      true,
      0
    )
  `;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Article Grids App Golden fixture", () => {
  test("keeps the article entry fixture structurally valid", async () => {
    const definition = await loadArticleDefinition();
    expect(definition.id).toBe(ARTICLE.appPublicId);
    expect(definition.baseId).toBe(ARTICLE.basePublicId);
  });

  postgresTest("executes parameterized child entry through the complete lifecycle", async () => {
    await cleanupArticleFixture();
    try {
      await insertArticleResources();
      const definition = await loadArticleDefinition();

      const validation = await compile(definition);
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
      expect(validation.compiled.capabilities).toEqual({
        availability: [],
        views: [
          {
            viewId: ARTICLE.listViewId,
            tableId: ARTICLE.listTableId,
            sourceHash: customAppViewSourceHash(ARTICLE.listTableId, `from table {a00201}`),
            planHash: expect.any(String),
            tableIds: [ARTICLE.listTableId],
          },
        ],
        insights: [],
        recordQueries: [
          {
            pageId: "list",
            blockId: "articles",
            primaryTableId: ARTICLE.articleTableId,
            planHash: expect.any(String),
            tableIds: [ARTICLE.articleTableId],
          },
        ],
        records: [
          {
            pageId: "list",
            tableId: ARTICLE.listTableId,
            fieldIds: [ARTICLE.listNameFieldId],
            editableFieldIds: [],
            relationLabels: [],
          },
        ],
        forms: [
          {
            pageId: "add-article",
            blockId: "article-form",
            formId: ARTICLE.articleFormId,
            tableId: ARTICLE.articleTableId,
            userInputFieldIds: [
              ARTICLE.articleListFieldId,
              ARTICLE.articleNameFieldId,
              ARTICLE.articleWeightFieldId,
              ARTICLE.articleDescriptionFieldId,
            ],
            fixedFieldIds: [ARTICLE.articleListFieldId],
            fieldHash: customAppFormFieldHash(
              [ARTICLE.articleListFieldId, ARTICLE.articleNameFieldId, ARTICLE.articleWeightFieldId, ARTICLE.articleDescriptionFieldId],
              [
                {
                  id: ARTICLE.articleListFieldId,
                  type: "relation",
                  config: { targetTableId: ARTICLE.listTableId, cardinality: "single" },
                  deletedAt: null,
                },
                { id: ARTICLE.articleNameFieldId, type: "text", config: {}, deletedAt: null },
                { id: ARTICLE.articleWeightFieldId, type: "number", config: {}, deletedAt: null },
                { id: ARTICLE.articleDescriptionFieldId, type: "longtext", config: {}, deletedAt: null },
              ],
            ),
            formSecurityHash: customAppFormSecurityHash({
              tableId: ARTICLE.articleTableId,
              config: {
                fields: [
                  ARTICLE.articleListFieldId,
                  ARTICLE.articleNameFieldId,
                  ARTICLE.articleWeightFieldId,
                  ARTICLE.articleDescriptionFieldId,
                ].map((fieldId) => ({ kind: "user_input", fieldId })),
              },
              fields: [
                {
                  id: ARTICLE.articleListFieldId,
                  tableId: ARTICLE.articleTableId,
                  type: "relation",
                  config: { targetTableId: ARTICLE.listTableId, cardinality: "single" },
                  required: false,
                  defaultValue: null,
                  deletedAt: null,
                },
                {
                  id: ARTICLE.articleNameFieldId,
                  tableId: ARTICLE.articleTableId,
                  type: "text",
                  config: {},
                  required: false,
                  defaultValue: null,
                  deletedAt: null,
                },
                {
                  id: ARTICLE.articleWeightFieldId,
                  tableId: ARTICLE.articleTableId,
                  type: "number",
                  config: {},
                  required: false,
                  defaultValue: null,
                  deletedAt: null,
                },
                {
                  id: ARTICLE.articleDescriptionFieldId,
                  tableId: ARTICLE.articleTableId,
                  type: "longtext",
                  config: {},
                  required: false,
                  defaultValue: null,
                  deletedAt: null,
                },
              ],
            }),
          },
        ],
        comments: [],
        documents: [],
        workflowLaunchers: [],
        scannerLaunchers: [],
      });

      const planned = await plan(definition);
      expect(planned).toEqual({ valid: true, diagnostics: [], action: "create", changes: ["app"] });
      expect(await plan(definition)).toEqual(planned);

      const created = await apply(definition);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      expect(created.data.shortId).toHaveLength(6);

      const exportedYaml = Bun.YAML.stringify(created.data.draftDefinition);
      const exported = CustomAppDefinitionSchema.parse(Bun.YAML.parse(exportedYaml));
      expect(exported).toEqual(definition);
      expect((await plan(exported)).action).toBe("noop");

      const reapplied = await apply(exported);
      expect(reapplied.ok).toBe(true);
      if (!reapplied.ok) throw new Error(reapplied.error.message);
      expect(reapplied.data.updatedAt).toBe(created.data.updatedAt);

      const grants = [
        {
          resourceType: "customApp",
          resourceId: created.data.id,
          principal: { type: "group", groupId: ARTICLE.contributorGroupId },
          permission: "read",
        },
        {
          resourceType: "customApp",
          resourceId: created.data.id,
          principal: { type: "group", groupId: ARTICLE.responsibleGroupId },
          permission: "read",
        },
      ] satisfies Array<Parameters<typeof grantAccess>[0]>;
      for (const grant of grants) {
        const result = await grantAccess(grant);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
      }

      expect(await listCustomAppAccess(created.data.id)).toHaveLength(2);

      const published = await publish(created.data.id);
      expect(published.ok).toBe(true);
      if (!published.ok) throw new Error(published.error.message);
      expect(published.data.publishedDefinition).toEqual(exported);
      expect(published.data.publishedCapabilities).toEqual(validation.compiled.capabilities);
      expect((await get(created.data.id))?.publishedCapabilities).toEqual(validation.compiled.capabilities);
    } finally {
      await cleanupArticleFixture();
    }
  });
});
