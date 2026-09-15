import { expect, test } from "bun:test";
import { fieldTypeRegistry } from "../field-types";
import { GRIDS_WORKFLOW_ACTION_METADATA } from "../workflows/action-metadata";
import { gridsHelp } from ".";

test("table help links to the shared formula reference in both languages", async () => {
  const knownIds = new Set(gridsHelp.documents.map((document) => document.id));
  for (const locale of ["en", "de"]) {
    const markdown = await Bun.file(new URL(`./documents/${locale}/grids-tables-fields.help.md`, import.meta.url)).text();
    expect(markdown).toContain("/app/grids/help/grids-formulas");
    for (const link of markdown.matchAll(/\]\(\/app\/grids\/help\/([a-z0-9-]+)\)/g)) {
      expect(knownIds.has(link[1]!), `${locale}: ${link[1]}`).toBe(true);
    }
    for (const fn of ["LIST_SUM", "LIST_AVG", "LIST_MIN", "LIST_MAX", "LIST_COUNT"]) expect(markdown).toContain(fn);
  }
});

test("every registered topic is bilingual, linked from the overview, and links only to registered help", async () => {
  const ids = new Set(gridsHelp.documents.map((document) => document.id));
  for (const locale of ["en", "de"]) {
    const overview = await Bun.file(new URL(`./documents/${locale}/grids-overview.help.md`, import.meta.url)).text();
    for (const id of ids) {
      const file = Bun.file(new URL(`./documents/${locale}/${id}.help.md`, import.meta.url));
      expect(await file.exists(), `${locale}/${id}`).toBe(true);
      const markdown = await file.text();
      if (id !== "grids-overview") expect(overview, `${locale}: discover ${id}`).toContain(`/help/${id}`);
      for (const match of markdown.matchAll(/\]\(\/app\/grids\/help\/([a-z0-9-]+)(?:#[^)]+)?\)/g)) {
        expect(ids.has(match[1]!), `${locale}/${id} → ${match[1]}`).toBe(true);
      }
    }
  }
});

test("all implemented field types and workflow actions have discoverable authoring reference entries", async () => {
  for (const locale of ["en", "de"]) {
    const fields = await Bun.file(new URL(`./documents/${locale}/grids-field-configuration.help.md`, import.meta.url)).text();
    for (const type of Object.keys(fieldTypeRegistry)) expect(fields, `${locale}: ${type}`).toContain(`\`${type}\``);
    for (const strategy of ["sequence", "date_sequence", "short_code", "random_code", "uuid", "uuidv7", "ulid"])
      expect(fields).toContain(`\`${strategy}\``);
    expect(fields).toContain('"creation" | "finalization"');
    expect(fields).toContain("cld grids fields type <type> --json");
    const workflows = await Bun.file(new URL(`./documents/${locale}/grids-workflows.help.md`, import.meta.url)).text();
    for (const action of Object.keys(GRIDS_WORKFLOW_ACTION_METADATA)) expect(workflows, `${locale}: ${action}`).toContain(`\`${action}\``);
    const camt = await Bun.file(new URL(`./documents/${locale}/grids-camt.help.md`, import.meta.url)).text();
    for (const feature of [
      "camt.052.001.08",
      "fileSnapshot",
      "lastPage",
      "CRDT",
      "DBIT",
      "BOOK",
      "PDNG",
      "5 MiB",
      "--sha256",
      "download-file",
    ])
      expect(camt, `${locale}: ${feature}`).toContain(feature);
  }
});
