import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProject, writeProject, writeManifest } from "../src/cli/project-files";
import { starter } from "../src/starter";
test("CLI checkout round-trips source and revision, refuses overwrite and symlinks", async () => {
  const temp = await mkdtemp(join(tmpdir(), "kit-checkout-"));
  const dir = join(temp, "project");
  try {
    await writeProject(dir, starter);
    expect((await readProject(dir)).project).toEqual(starter);
    await writeManifest(dir, starter, { id: "abc123", revision: 7 });
    const loaded = await readProject(dir);
    expect(loaded.id).toBe("abc123");
    expect(loaded.revision).toBe(7);
    expect(loaded.entries.length).toBe(2);
    await expect(writeProject(dir, starter)).rejects.toThrow();
    const path = join(dir, starter.files[0]!.path);
    await rm(path);
    await writeFile(join(temp, "outside.js"), "secret");
    await symlink(join(temp, "outside.js"), path);
    await expect(readProject(dir)).rejects.toThrow("Symlinks");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
