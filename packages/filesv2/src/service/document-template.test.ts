import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { extractZip } from "@k2b/stdlib/browser";
import { documentTemplate } from "./document-template";

const root = resolve(import.meta.dir, "../../../..");
const extensions = ["docx", "odp", "ods", "odt", "pptx", "xlsx"];

/** The XML parts of a template, by entry name. */
async function xmlParts(extension: string): Promise<Map<string, string>> {
  const entries = await extractZip(new Uint8Array(await (await documentTemplate(extension)).arrayBuffer()));
  return new Map(
    entries.filter((entry) => /\.(xml|rels)$/.test(entry.filename)).map((entry) => [entry.filename, new TextDecoder().decode(entry.data)]),
  );
}

/** The attributes of every `<name …>` element in the parts, in order; attribute order and spacing do not matter. */
function elements(parts: Map<string, string>, name: string): Record<string, string>[] {
  return [...parts.values()].flatMap((xml) =>
    [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?/?>`, "g"))].map(([, attributes = ""]) =>
      Object.fromEntries([...attributes.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map(([, key, value]) => [key, value])),
    ),
  );
}

/** The attributes that decide paper size and orientation, by the element that declares them; slide sizes are not paper. */
const PAPER: Record<string, string[]> = {
  "w:pgSz": ["w:w", "w:h", "w:orient"],
  pageSetup: ["paperSize", "orientation"],
  "style:page-layout-properties": ["fo:page-width", "fo:page-height", "style:print-orientation"],
  "p:notesSz": ["cx", "cy"],
};
const ODF_A4 = {
  "style:page-layout-properties": { "fo:page-width": "21cm", "fo:page-height": "29.7cm", "style:print-orientation": "portrait" },
};
const A4: Record<string, Record<string, Record<string, string>>[]> = {
  // Without w:orient, the section is portrait.
  docx: [{ "w:pgSz": { "w:w": "11906", "w:h": "16838" } }],
  odp: [],
  ods: [ODF_A4],
  odt: [ODF_A4],
  // PowerPoint prints notes pages on notesSz; Collabora ignores it and takes notes and handout pages from the user's locale.
  pptx: [{ "p:notesSz": { cx: "7560000", cy: "10692000" } }],
  xlsx: [{ pageSetup: { paperSize: "9", orientation: "portrait" } }],
};

describe("document templates", () => {
  test("every supported extension has a non-empty template in the source tree", async () => {
    for (const extension of extensions) {
      expect((await documentTemplate(extension)).size, extension).toBeGreaterThan(0);
    }
  });

  test("no template pins a language, so new documents take the editor's language and its spelling dictionary", async () => {
    for (const extension of extensions) {
      for (const [name, xml] of await xmlParts(extension))
        expect(xml, `${extension}: ${name}`).not.toMatch(/\blang=|<w:lang\b|<dc:language>|fo:language=/);
    }
  });

  test("every printable template pins A4 portrait, because an unpinned page follows the editor's language and is Letter in en-US", async () => {
    for (const extension of extensions) {
      const parts = await xmlParts(extension);
      const declared = Object.entries(PAPER).flatMap(([name, decisive]) =>
        elements(parts, name).map((found) => ({
          [name]: Object.fromEntries(decisive.filter((attribute) => attribute in found).map((attribute) => [attribute, found[attribute]])),
        })),
      );
      expect(declared, extension).toEqual(A4[extension] ?? []);
    }
  });

  test("the ODF page layouts belong to the page style the document uses", async () => {
    const text = await xmlParts("odt");
    expect(elements(text, "style:master-page")).toEqual([{ "style:name": "Standard", "style:page-layout-name": "pm1" }]);
    // Calc stores its default page style under a localized name, so the sheet names its page style explicitly.
    const spreadsheet = await xmlParts("ods");
    expect(elements(spreadsheet, "style:master-page")).toEqual([{ "style:name": "Default", "style:page-layout-name": "pm1" }]);
    expect(elements(spreadsheet, "style:style")).toContainEqual({
      "style:name": "ta1",
      "style:family": "table",
      "style:master-page-name": "Default",
    });
    expect(elements(spreadsheet, "table:table").map((table) => table["table:style-name"])).toEqual(["ta1"]);
    for (const parts of [text, spreadsheet]) {
      expect(elements(parts, "style:page-layout")).toEqual([{ "style:name": "pm1" }]);
      expect(elements(parts, "manifest:file-entry")).toContainEqual({
        "manifest:full-path": "styles.xml",
        "manifest:media-type": "text/xml",
      });
    }
  });

  test("new spreadsheets print the sheet name and page number like Calc's own page style, as fields rather than words", async () => {
    const styles = (await xmlParts("ods")).get("styles.xml") ?? "";
    const region = (name: string) => styles.match(new RegExp(`<style:${name}(?:\\s[^>]*)?>(.*?)</style:${name}>`, "s"))?.[1] ?? "";
    expect(region("header")).toMatch(/<text:sheet-name\b/);
    expect(region("footer")).toMatch(/<text:page-number\b/);
    for (const name of ["header", "footer"]) expect(region(name).replace(/<[^>]*>/g, ""), name).not.toMatch(/\p{L}/u);
  });

  test("a missing template is reported as a packaging defect", async () => {
    await expect(documentTemplate("nope")).rejects.toMatchObject({ code: "template_missing", status: 503 });
  });

  test("a template path that cannot be resolved is the same defect, with the cause attached", async () => {
    const error = await documentTemplate("/../../../x").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "template_missing", status: 503 });
    expect(((error as Error).cause as Error).message).toBe("Asset path escapes src/assets: templates/empty./../../../x");
  });

  test("the production build ships every template next to the bundle", async () => {
    const build = Bun.spawn([process.execPath, "run", "packages/cloud/scripts/build.ts"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", APP_ID: "filesv2" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(exit, `${out}\n${err}`).toBe(0);
    expect(await Bun.file(resolve(root, "dist/server.js")).text()).toContain('"./assets/"');
    expect((await readdir(resolve(root, "dist/assets/templates"))).sort()).toEqual(extensions.map((extension) => `empty.${extension}`));
  }, 120_000);
});
