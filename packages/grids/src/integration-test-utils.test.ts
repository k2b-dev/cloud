import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { TEST_SHORT_ID_MARK, testShortId } from "./integration-test-utils";
import { newShortId, SHORT_ID_REGEX } from "./service/short-id";

const packageRoot = join(import.meta.dir, "..");
const generator = new Set(["src/integration-test-utils.ts", "src/integration-test-utils.test.ts"]);
const testSource = /\.test\.|test-|fixture/;
const usesTestDatabase = /\bpostgresTest\b|testFor\("database"\)|import \{[^}]*\b(?:sql|SQL)\b[^}]*\} from "bun";/;
const adHocShortId = /Math\.random\(|\.toString\(36\)|\bnewShortId\b|\breadableId\b|testShortId\([^)]*\)\.(?:slice|substring)\(/;

test("fixture short IDs never repeat and never look like generated ones", () => {
  const fixtures = Array.from({ length: 1_000 }, () => testShortId());
  expect(new Set(fixtures).size).toBe(fixtures.length);
  expect(fixtures.filter((id) => !SHORT_ID_REGEX.test(id) || !id.startsWith(TEST_SHORT_ID_MARK))).toEqual([]);
  // Services insert newShortId() values into the same database and retry only their own collisions.
  const generated = Array.from({ length: 10_000 }, () => newShortId());
  expect(generated.filter((id) => id.toLowerCase().includes(TEST_SHORT_ID_MARK))).toEqual([]);
});

test("Grids database tests take fixture short IDs only from testShortId", async () => {
  const adHoc: string[] = [];
  for await (const file of new Bun.Glob("{src,scripts,test}/**/*.{ts,tsx}").scan({ cwd: packageRoot })) {
    if (!testSource.test(basename(file)) || generator.has(file)) continue;
    const text = await Bun.file(join(packageRoot, file)).text();
    if (!usesTestDatabase.test(text)) continue;
    for (const [index, line] of text.split("\n").entries()) {
      if (adHocShortId.test(line)) adHoc.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  // Use testShortId() from src/integration-test-utils.ts; any other source can repeat an ID it issues.
  expect(adHoc).toEqual([]);
});
