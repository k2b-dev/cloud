import { describe, expect, test } from "bun:test";
import { AGGREGATE_KINDS } from "../aggregate-catalog";
import { DOCUMENT_TEMPLATE_STARTERS } from "../document-template-starters";
import { GRID_FORMULA_FUNCTIONS } from "../formula/function-catalog";
import { parseFormula } from "../formula/parser";
import {
  GROUP_GRANULARITIES,
  PREDICATE_COMPARISON_OPERATORS,
  PREDICATE_FUNCTIONS,
  PREDICATE_OPERATORS,
} from "../query-dsl/intelligence-grammar";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { gridsHelp } from ".";

const cliSkillReference = await Bun.file(new URL("../../../../skills/cloud-cli/references/grids.md", import.meta.url)).text();

const expectedTopics = [
  "grids-overview",
  "grids-core-model",
  "grids-build-base",
  "grids-tables-fields",
  "grids-views-reports",
  "grids-combined-tables",
  "grids-gql",
  "grids-formulas",
  "grids-forms",
  "grids-build-custom-app",
  "grids-custom-app-pages-blocks",
  "grids-documents-pdfs",
  "grids-publish-custom-app",
  "grids-custom-app-yaml-cli",
  "grids-custom-apps",
  "grids-workflows",
  "grids-permissions",
  "grids-evidence-exports",
  "grids-retention-preservation",
  "grids-operations-troubleshooting",
];

describe("grids help", () => {
  test("keeps every established topic in its existing order", () => {
    expect(gridsHelp.documents.map((document) => document.id)).toEqual(expectedTopics);

    const english = gridsHelp.documentsByLocale?.en ?? [];
    const german = gridsHelp.documentsByLocale?.de ?? [];
    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }
  });

  test("serves the established reference content from Markdown", () => {
    for (const document of gridsHelp.documents) {
      const markdown = gridsHelp.getMarkdown(document.id);
      expect(markdown, `${document.id} should have Markdown content`).toBeDefined();
      expect(markdown!.trim().length).toBeGreaterThan(100);
    }

    expect(gridsHelp.getMarkdown("grids-gql")).toContain("from table Books");
    expect(gridsHelp.getMarkdown("grids-workflows")).toContain("A workflow does not need a YAML trigger");
    expect(gridsHelp.getMarkdown("grids-documents-pdfs")).toContain("Liquid + GQL");
    expect(gridsHelp.getMarkdown("grids-combined-tables")).toContain("Fail-closed publication");
  });

  test("keeps implementation stack details out of end-user help", () => {
    const markdown = ["en", "de"]
      .flatMap((locale) => gridsHelp.documents.map((document) => gridsHelp.getMarkdown(document.id, locale)))
      .join("\n");

    for (const implementationTerm of [
      /\bGotenberg\b/i,
      /\bPostgreSQL\b/i,
      /\bLiquidJS\b/i,
      /\bSQL\b/,
      /server cursors/i,
      /live event stream/i,
      /durable intents/i,
      /socket connection/i,
      /DNS address/i,
    ]) {
      expect(markdown).not.toMatch(implementationTerm);
    }
  });

  test("covers the product areas a new user must be able to discover", () => {
    const tables = gridsHelp.getMarkdown("grids-tables-fields")!;
    for (const fieldType of [
      "Text",
      "Long text",
      "Number",
      "Percent",
      "Boolean",
      "Date",
      "Duration",
      "Select",
      "Principal",
      "JSON",
      "File",
      "Relation",
      "Lookup",
      "Rollup",
      "Formula",
      "ID",
    ]) {
      expect(tables, `missing field type ${fieldType}`).toContain(fieldType);
    }

    const forms = gridsHelp.getMarkdown("grids-forms")!;
    for (const capability of ["Public form", "required inputs", "hidden values", "redirect", "Grids App"]) {
      expect(forms, `missing form capability ${capability}`).toContain(capability);
    }

    const customApps = gridsHelp.getMarkdown("grids-custom-apps")!;
    for (const capability of [
      "Markdown",
      "Records",
      "Metrics",
      "Chart",
      "Comments",
      "saved view",
      "apps create",
      "apps validate",
      "apps plan",
      "apps apply",
      "apps publish",
      "apps unpublish",
      "apps restore",
      "apps delete",
    ]) {
      expect(customApps, `missing Grids App capability ${capability}`).toContain(capability);
    }
    expect(customApps).toContain("public grant includes anonymous visitors");

    const documents = gridsHelp.getMarkdown("grids-documents-pdfs")!;
    for (const capability of ["recursive snapshot", "public link", "1, 7, 30, or 90 days", "barcode_data_url"]) {
      expect(documents, `missing document capability ${capability}`).toContain(capability);
    }
    for (const starter of DOCUMENT_TEMPLATE_STARTERS) {
      expect(documents, `missing document starter ${starter.name}`).toContain(`\`${starter.name}\``);
    }

    const formulas = gridsHelp.getMarkdown("grids-formulas")!;
    for (const fn of GRID_FORMULA_FUNCTIONS) {
      expect(formulas, `missing formula function ${fn.name}`).toContain(fn.signature);
      expect(cliSkillReference, `CLI reference missing formula function ${fn.name}`).toContain(fn.signature);
    }

    const permissions = gridsHelp.getMarkdown("grids-permissions")!;
    expect(permissions).toContain("Cloud administrators are not automatic Grids superusers");
    expect(permissions).toContain("Read the complete schema and every record");
    expect(permissions).toContain("hiding a control in the browser is not authorization");
    expect(permissions).toContain("Base grants support users, groups, service accounts");
    expect(permissions).toContain("Grids App grants do not support service accounts");
    for (const resource of ["Base", "Grids App"]) {
      expect(permissions, `missing permission resource ${resource}`).toContain(resource);
    }

    const gql = gridsHelp.getMarkdown("grids-gql")!;
    for (const term of [
      ...GROUP_GRANULARITIES,
      ...AGGREGATE_KINDS,
      ...PREDICATE_FUNCTIONS.map((item) => item.label),
      ...PREDICATE_OPERATORS.map((item) => item.label),
      ...PREDICATE_COMPARISON_OPERATORS.map((item) => item.label),
      "record.id",
      "record.createdBy",
      "record.updatedBy",
      "record.deletedBy",
      "record.createdAt",
      "record.updatedAt",
      "record.deletedAt",
    ]) {
      expect(gql, `missing GQL reference term ${term}`).toContain(term);
      expect(cliSkillReference, `CLI reference missing GQL term ${term}`).toContain(term);
    }

    expect(tables).toContain("browser's timezone");
    expect(tables).toContain("Choose where record changes can start");
    expect(tables).toContain("Direct editing and record API");
    expect(tables).toContain("Choosing no source freezes record changes");
    expect(tables).toContain("does not by itself provide a legal or regulatory guarantee");
    expect(documents).toContain('class="pageNumber"');
  });

  test("keeps every GQL-fenced help example accepted by the public parser", () => {
    const markdown = gridsHelp.getMarkdown("grids-gql")!;
    const examples = [...markdown.matchAll(/```gql\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());

    expect(examples.length).toBeGreaterThan(0);
    for (const source of examples) {
      const parsed = parseGridsQueryDsl(source);
      expect(parsed.ok, source).toBe(true);
    }
  });

  test("keeps every formula help example accepted by the public parser", () => {
    const markdown = gridsHelp.getMarkdown("grids-formulas")!;
    const examples = [...markdown.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());

    expect(examples.length).toBeGreaterThan(0);
    for (const source of examples) {
      const parsed = parseFormula(source);
      expect(parsed.ok, source).toBe(true);
    }
  });

  test("serves every article in German for regional locales", () => {
    for (const id of expectedTopics) {
      const german = gridsHelp.getMarkdown(id, "de");
      expect(german, `${id} should have German Markdown`).toBeDefined();
      expect(german, `${id} should resolve de-CH through de`).toBe(gridsHelp.getMarkdown(id, "de-CH"));
      expect(german!.trim().length, `${id} should have complete German content`).toBeGreaterThan(100);
    }
    expect(gridsHelp.getMarkdown("grids-overview", "de-CH")).toContain("Mit Grids verwaltet ein Team");
    expect(gridsHelp.getMarkdown("grids-workflows", "de-CH")).toContain("Ein Workflow benötigt keinen YAML-Trigger");
    expect(gridsHelp.getMarkdown("grids-retention-preservation", "de-CH")).toContain("Mindestaufbewahrung");
  });

  test("keeps fenced technical examples identical across locales", () => {
    const codeBlocks = (markdown: string | undefined) => markdown?.match(/```[\s\S]*?```/g) ?? [];

    for (const id of expectedTopics) {
      expect(codeBlocks(gridsHelp.getMarkdown(id, "de")), id).toEqual(codeBlocks(gridsHelp.getMarkdown(id, "en")));
    }
  });

  test("falls back to English for unsupported locales", () => {
    expect(gridsHelp.getMarkdown("grids-overview", "fr")).toBe(gridsHelp.getMarkdown("grids-overview"));
  });
});
