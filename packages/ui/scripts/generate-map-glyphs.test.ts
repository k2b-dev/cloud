import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateMapGlyphs } from "./generate-map-glyphs";

const fingerprint = async (root: string) => {
  const paths: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) paths.push(relative);
      else throw new Error(`Unexpected glyph asset: ${relative}`);
    }
  };
  await visit("");
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const bytes = await readFile(join(root, path));
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

test("two pinned generations equal the committed assets and remove stale ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "k2b-map-glyphs-test-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(join(first, "IBM Plex Sans Medium"), { recursive: true });
    await writeFile(join(first, "IBM Plex Sans Medium", "stale.pbf"), "stale");
    const firstSizes = await generateMapGlyphs(first);
    const secondSizes = await generateMapGlyphs(second);
    expect(firstSizes).toEqual(secondSizes);
    expect(firstSizes.fileCount).toBeGreaterThan(1);
    expect(firstSizes.rawBytes).toBeGreaterThan(firstSizes.gzipBytes);
    expect(await fingerprint(first)).toBe(await fingerprint(second));
    if (process.platform === "linux" && process.arch === "x64") {
      expect(await fingerprint(first)).toBe(await fingerprint(resolve(import.meta.dir, "../map-glyphs")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
