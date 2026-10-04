import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { TEST_SHORT_ID_MARK, testShortId } from "./integration-test-utils";
import { newShortId, SHORT_ID_REGEX } from "./service/short-id";

const packageRoot = join(import.meta.dir, "..");
const generator = new Set(["src/integration-test-utils.ts", "src/integration-test-utils.test.ts"]);
const testSource = /\.test\.|test-|fixture/;
const usesTestDatabase = /\bpostgresTest\b|testFor\([^)]*"database"|import \{[^}]*\b(?:sql|SQL)\b[^}]*\} from "bun";/;
const comment = /^\s*(?:\/\/|\/\*|\*)/;
/** Common ways to make up a short ID without testShortId(). Each can repeat a value that another fixture inserts later. */
const adHocShortId = [
  /\brandom\(/, // Math.random() and SQL random()
  /\.toString\(36\)/, // base36 counters and hashes
  /\b(?:newShortId|readableId)\b/, // the service generator; only services retry its collisions
  /(?:padStart\(|lpad\([^,]+,)\s*[56]\b/, // counters padded to short-ID length
  /\b(?:slice|substring|substr)\((?:[^(),]*,)?\s*-?[56]\s*\)/, // values cut to short-ID length
];

/** 1-based lines of `source`, outside comments, that make up a short ID without testShortId(). */
const adHocShortIdLines = (source: string): number[] => {
  // A piece of a fixture ID repeats part of the counter, also after the ID went through a variable.
  const fixtureIds = new Set([...source.matchAll(/\b(\w+)\s*[:=]\s*testShortId\(\)/g)].map((match) => `|\\b${match[1]}`));
  const pieces = new RegExp(`(?:testShortId\\(\\)\\}?\`?${[...fixtureIds].join("")})\\.(?:slice|substring|substr)\\(`);
  return source
    .split("\n")
    .flatMap((line, index) => (!comment.test(line) && [...adHocShortId, pieces].some((pattern) => pattern.test(line)) ? [index + 1] : []));
};

test("fixture short IDs never repeat and never look like generated ones", () => {
  const fixtures = Array.from({ length: 1_000 }, () => testShortId());
  expect(new Set(fixtures).size).toBe(fixtures.length);
  expect(fixtures.filter((id) => !SHORT_ID_REGEX.test(id) || !id.startsWith(TEST_SHORT_ID_MARK))).toEqual([]);
  // Services insert newShortId() values into the same database and retry only their own collisions.
  const generated = Array.from({ length: 10_000 }, () => newShortId());
  expect(generated.filter((id) => id.toLowerCase().includes(TEST_SHORT_ID_MARK))).toEqual([]);
});

test("the fixture guard recognizes common ad-hoc short IDs and skips comments", () => {
  const adHoc = [
    "const id = `T${Math.random().toString(36).slice(2, 7)}`;",
    "const id = newShortId();",
    "const id = `R${String(++count).padStart(5, '0')}`;",
    "SELECT ${prefix} || lpad(value::text, 5, '0') FROM generate_series(1, 10) value",
    "SELECT substr(md5(random()::text), 1, 6)",
    "const id = testUuid().replace(/-/g, '').slice(0, 6);",
    "const id = Bun.randomUUIDv7().slice(-6);",
    "const id = crypto.randomUUID().slice(0, 6);",
    "const id = `${testShortId()}`.slice(1);",
  ];
  expect(adHoc.filter((line) => adHocShortIdLines(line).length === 0)).toEqual([]);
  expect(adHocShortIdLines("const prefix = testShortId();\nconst id = `${prefix.slice(0, 2)}${index}`;")).toEqual([2]);
  const harmless = [
    "// Services insert newShortId() values and retry their own collisions.",
    " * readableId() never emits an o.",
    "const id = testShortId();",
    "const suffix = crypto.randomUUID().slice(0, 8);",
    "const day = String(date.getDate()).padStart(2, '0');",
    "const today = new Date().toISOString().slice(0, 10);",
    "SELECT gen_random_uuid() FROM generate_series(1, 10)",
  ];
  expect(harmless.filter((line) => adHocShortIdLines(line).length > 0)).toEqual([]);
});

test("Grids database tests take fixture short IDs only from testShortId", async () => {
  const adHoc: string[] = [];
  for await (const file of new Bun.Glob("{src,scripts,test}/**/*.{ts,tsx}").scan({ cwd: packageRoot })) {
    if (!testSource.test(basename(file)) || generator.has(file)) continue;
    const text = await Bun.file(join(packageRoot, file)).text();
    if (!usesTestDatabase.test(text)) continue;
    const lines = text.split("\n");
    for (const line of adHocShortIdLines(text)) adHoc.push(`${file}:${line}: ${lines[line - 1]?.trim()}`);
  }
  // Use testShortId() from src/integration-test-utils.ts; any other source can repeat an ID it issues.
  expect(adHoc).toEqual([]);
});
