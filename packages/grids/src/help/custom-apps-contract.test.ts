import { describe, expect, test } from "bun:test";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { gridsHelp } from ".";

const detailedHelpFiles = [
  "grids-build-custom-app.help.md",
  "grids-custom-app-pages-blocks.help.md",
  "grids-publish-custom-app.help.md",
  "grids-custom-app-yaml-cli.help.md",
] as const;

const exampleFiles = [
  "certificate-requests.yaml",
  "certificate-review.yaml",
  "article-entry.yaml",
  "reimbursement-requests.yaml",
  "reimbursement-review.yaml",
] as const;

type DefinitionNode = {
  id?: unknown;
  startPageId?: unknown;
  pages?: DefinitionNode[];
  rows?: DefinitionNode[];
  columns?: DefinitionNode[];
  blocks?: DefinitionNode[];
};

const assertUniqueIds = (items: DefinitionNode[] | undefined, location: string): void => {
  const ids = (items ?? []).map((item) => item.id);
  expect(
    ids.every((id) => typeof id === "string" && id.length > 0),
    `${location} ids`,
  ).toBe(true);
  expect(new Set(ids).size, `${location} ids`).toBe(ids.length);
};

const visitObjects = (value: unknown, visit: (object: Record<string, unknown>) => void): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visit);
    return;
  }
  const object = value as Record<string, unknown>;
  visit(object);
  for (const child of Object.values(object)) visitObjects(child, visit);
};

describe("Grids Apps documentation contract", () => {
  test("keeps the detailed articles complete and registered in live Help", async () => {
    const knownIds = new Set(gridsHelp.documents.map((document) => document.id));

    for (const filename of detailedHelpFiles) {
      const markdown = await Bun.file(new URL(`./documents/en/${filename}`, import.meta.url)).text();
      const id = filename.replace(".help.md", "");

      expect(markdown.trim().length, filename).toBeGreaterThan(1_000);
      expect(gridsHelp.getMarkdown(id), `${id} must be live`).toBeDefined();

      for (const link of markdown.matchAll(/\]\(\/app\/grids\/help\/([a-z0-9-]+)\)/g)) {
        expect(knownIds.has(link[1]!), `${filename} link to ${link[1]}`).toBe(true);
      }
    }
  });

  test("documents the implemented Record-only page parameter contract", async () => {
    const markdown = await Bun.file(new URL("./documents/en/grids-custom-app-pages-blocks.help.md", import.meta.url)).text();

    expect(markdown).toContain("This release supports required Record parameters only.");
    expect(markdown).toContain("its URL and `@params.<name>` value are record public IDs");
    expect(markdown).not.toContain("Supported parameter types are String, Number, Boolean, Date, Date time, and Record.");
  });

  test("documents progressive visual authoring and contextual GQL", async () => {
    const overview = await Bun.file(new URL("./documents/en/grids-custom-apps.help.md", import.meta.url)).text();
    const builder = await Bun.file(new URL("./documents/en/grids-build-custom-app.help.md", import.meta.url)).text();
    const pages = await Bun.file(new URL("./documents/en/grids-custom-app-pages-blocks.help.md", import.meta.url)).text();
    const yaml = await Bun.file(new URL("./documents/en/grids-custom-app-yaml-cli.help.md", import.meta.url)).text();

    expect(overview).toContain("/app/grids/help/grids-build-custom-app");
    expect(builder).toContain("opened in a larger editor without creating a second draft");
    expect(builder).toContain("there is no separate Page Record setting");
    expect(builder).toContain("You may edit them in Page settings");
    expect(pages).toContain("@auth.name");
    expect(pages).toContain("Inline GQL displays its selected ordinary-record columns");
    expect(pages).toContain("existing enabled Grids App workflow launcher");
    expect(yaml).toContain("apps restore");
    expect(yaml).toContain("--published");
    expect(builder).toContain("**App settings → Lifecycle**");
    expect(builder).toContain("**General**, **Access**, and **Lifecycle**");
    expect(builder).toContain("Choose an existing entry under **Actions**");
    expect(builder).toContain("does not delete Base tables or records");
    expect(pages).toContain("there are no Liquid conditions or loops");
    expect(pages).toContain("the raw GQL console deliberately does not offer Grids App `@…` context");
  });

  test("keeps removed dual-ID surfaces out of the written contract", async () => {
    const overview = await Bun.file(new URL("./documents/en/grids-custom-apps.help.md", import.meta.url)).text();
    const pages = await Bun.file(new URL("./documents/en/grids-custom-app-pages-blocks.help.md", import.meta.url)).text();
    const yaml = await Bun.file(new URL("./documents/en/grids-custom-app-yaml-cli.help.md", import.meta.url)).text();
    const cli = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();

    expect(overview).not.toContain("**Bulk actions**");
    expect(yaml).toContain("canonical public resource IDs");
    expect(pages).toContain("Fields outside the block's editable subset remain read-only");
    expect(pages).toContain("without Base or record Write access");
    expect(yaml).toContain("{ source: ROW, path: relation, fieldId:");
    expect(cli).toContain("Referenced records, Metrics, Chart, Record, Rendered HTML, Form, Comments, Actions, and Scanner blocks");
    expect(cli).toContain("row id or one selected single relation");
  });

  test("keeps the strict YAML root example aligned with the public schema", async () => {
    const markdown = await Bun.file(new URL("./documents/en/grids-custom-app-yaml-cli.help.md", import.meta.url)).text();
    const source = markdown.match(/## Use one strict root document[\s\S]*?```yaml\n([\s\S]*?)```/)?.[1];

    expect(source).toBeDefined();
    expect(CustomAppDefinitionSchema.safeParse(Bun.YAML.parse(source!)).success).toBe(true);
  });

  test("keeps every Golden YAML example parseable and structurally deterministic", async () => {
    for (const filename of exampleFiles) {
      const source = await Bun.file(new URL(`../../docs/custom-apps/${filename}`, import.meta.url)).text();
      const definition = Bun.YAML.parse(source) as DefinitionNode & Record<string, unknown>;

      expect(definition.schemaVersion, filename).toBe(5);
      expect(definition.kind, filename).toBe("grids.custom-app");
      expect(typeof definition.id, filename).toBe("string");
      expect(typeof definition.baseId, filename).toBe("string");
      expect(definition.shortId, `${filename} must expose only id`).toBeUndefined();
      expect(definition.pages?.length ?? 0, filename).toBeGreaterThan(0);
      expect(
        definition.pages?.some((page) => page.id === definition.startPageId),
        filename,
      ).toBe(true);

      assertUniqueIds(definition.pages, `${filename} pages`);
      for (const page of definition.pages ?? []) {
        assertUniqueIds(page.rows, `${filename}/${String(page.id)} rows`);
        for (const row of page.rows ?? []) {
          assertUniqueIds(row.columns, `${filename}/${String(page.id)}/${String(row.id)} columns`);
          for (const column of row.columns ?? []) {
            assertUniqueIds(column.blocks, `${filename}/${String(page.id)}/${String(row.id)}/${String(column.id)} blocks`);
          }
        }
      }

      visitObjects(definition, (object) => {
        expect(object.visibleWhen, `${filename} removed visibleWhen`).toBeUndefined();
        if (object.availableWhen !== undefined) {
          expect(object.availableWhen, `${filename} availableWhen`).toEqual({ query: expect.any(String) });
        }
        if (object.kind !== "gql") return;
        expect(typeof object.query, `${filename} GQL source`).toBe("string");
        expect(object, `${filename} GQL source`).not.toHaveProperty("maxRows");
        expect(object.inputs, `${filename} removed GQL inputs`).toBeUndefined();

        const query = String(object.query);
        expect(query, `${filename} removed param()`).not.toMatch(/\bparam\s*\(/);
      });
    }
  });
});
