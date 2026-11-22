import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDatevXmlSchemas } from "./index";

test("loadDatevXmlSchemas reads only the required schema files and skips missing ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stdlib-datev-schemas-"));
  try {
    await writeFile(join(directory, "Document_v060.xsd"), "<x/>");
    await writeFile(join(directory, "other.xsd"), "<y/>");
    expect(await loadDatevXmlSchemas(directory)).toEqual({ "Document_v060.xsd": "<x/>" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
