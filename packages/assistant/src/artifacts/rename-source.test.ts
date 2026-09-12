import { expect, test } from "bun:test";
import { renameSource } from "./rename-source";

test("renaming a TypeScript module updates imports, re-exports, dynamic imports and entry without touching text", () => {
  const source = {
    entry: "main.ts",
    files: [
      {
        path: "main.ts",
        content:
          'import type { Item } from "./types.ts"; export { x } from "./lib.ts"; const lazy=()=>import("./lib.ts"); const text="./lib.ts"; // ./lib.ts\nexport default () => lazy();',
      },
      { path: "lib.ts", content: 'export { Item } from "./types.ts"; export const x:number=1;' },
      { path: "types.ts", content: "export type Item={value:number};" },
    ],
  };
  const renamed = renameSource(source, "lib.ts", "helpers/lib.ts");
  expect(renamed.files[0]!.content).toContain('from "./helpers/lib.ts"');
  expect(renamed.files[0]!.content).toContain('import("./helpers/lib.ts")');
  expect(renamed.files[0]!.content).toContain('const text="./lib.ts"; // ./lib.ts');
  expect(renamed.files[1]).toMatchObject({
    path: "helpers/lib.ts",
    content: 'export { Item } from "../types.ts"; export const x:number=1;',
  });
  expect(renameSource(source, "main.ts", "start.ts").entry).toBe("start.ts");
  expect(source.files[1]!.path).toBe("lib.ts");
});
test("rename rejects syntax errors, traversal, duplicates and invalid entry extensions atomically", () => {
  const source = {
    entry: "main.ts",
    files: [
      { path: "main.ts", content: "export default () => 1;" },
      { path: "broken.ts", content: "export const = !!!" },
    ],
  };
  expect(() => renameSource(source, "main.ts", "new.ts")).toThrow();
  expect(() => renameSource(source, "main.ts", "../new.ts")).toThrow();
  expect(() => renameSource(source, "main.ts", "broken.ts")).toThrow();
  expect(() => renameSource({ entry: "main.ts", files: [source.files[0]] }, "main.ts", "main.txt")).toThrow();
});
