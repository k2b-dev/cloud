import { expect, test } from "bun:test";
import { moduleSpecifiers } from "./imports";

const values = (source: string) => moduleSpecifiers(source).map((specifier) => specifier.value);

test("static imports, re-exports and import() with a string are module specifiers", () => {
  expect(
    values(`import "./setup.js";
import { a } from "./a.js";
import * as b from '../b.js';
import c, { d } from"./c.js";
export { e } from "./e.js";
export * from "./f.js";
const g = await import("./g.js");
const h = await import ( "./h.js" , { with: {} } );`),
  ).toEqual(["./setup.js", "./a.js", "../b.js", "./c.js", "./e.js", "./f.js", "./g.js", "./h.js"]);
});

test("offsets cover the specifier without quotes", () => {
  const source = `import { a } from "./a.js";`;
  const [specifier] = moduleSpecifiers(source);
  expect(source.slice(specifier!.start, specifier!.end)).toBe("./a.js");
});

test("import-like text in comments, strings, templates and regular expressions is no import", () => {
  expect(
    values(`// import "./old.js" was removed
/* import { x } from "./gone.js" */
const label = 'Import from "./data.csv"';
const other = "import './nothing.js'";
const help = \`import "./template.js" and \${"x" + \`import "./nested.js"\`}\`;
const pattern = /from "\\.\\/regex\\.js"/;
const ratio = total / 2, half = count / 3; // division, then a comment
const meta = new URL("./asset.js", import.meta.url);
const property = loader.import("./property.js") + Array.from("./chars");
const dynamic = import("./" + name);
import { real } from "./real.js";`),
  ).toEqual(["./real.js"]);
});

test("a template expression with braces resumes the template afterwards", () => {
  expect(values('const t = `${ { a: 1 }.a } import "./no.js"`;\nimport "./yes.js";')).toEqual(["./yes.js"]);
});
