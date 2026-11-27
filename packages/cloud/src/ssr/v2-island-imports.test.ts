import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A v2 island imports @k2b/ui only through `@k2b/ui/v2`: the root entry carries v1 into every v2 page that loads the
// island (#4242). The bundle guard builds one test island; this reads every island of Cloud's frame as written.
test("Cloud's v2 islands import nothing from the v1 root of @k2b/ui", () => {
  const dir = import.meta.dir;
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith(".island.tsx"))
    .filter((name) => {
      const source = readFileSync(join(dir, name), "utf8");
      return /from "@k2b\/ui\/v2"/.test(source) && /from "@k2b\/ui"/.test(source);
    });
  expect(offenders).toEqual([]);
});
