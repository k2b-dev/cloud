import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PublicId, ProjectInput, FilePath, type Bundle } from "../contracts";
import { validateProject } from "../project";

const Manifest = ProjectInput.omit({ files: true })
  .extend({
    id: PublicId.optional(),
    revision: z.number().int().positive().optional(),
    files: z.array(FilePath).min(1),
  })
  .strict();
export async function readProject(directory: string) {
  const manifest = Manifest.parse(JSON.parse(await readFile(join(directory, "kit.json"), "utf8")));
  const files = await Promise.all(
    manifest.files.map(async (path) => {
      let current = directory;
      for (const segment of path.split("/")) {
        current = join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlinks are not supported: ${path}`);
      }
      return { path, content: await readFile(current, "utf8") };
    }),
  );
  const { id, revision, ...metadata } = manifest;
  if ((id === undefined) !== (revision === undefined)) throw new Error("App id and revision must be present together");
  return { ...validateProject({ ...metadata, files }), id, revision };
}
export async function writeProject(directory: string, input: ProjectInput, identity?: Pick<Bundle, "id" | "revision">) {
  const { project } = validateProject(input);
  // Exclusive directory creation prevents accidental overwrite of an existing checkout.
  await mkdir(directory);
  for (const file of project.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: "wx" });
  }
  await writeManifest(directory, project, identity);
}
export async function writeManifest(directory: string, project: ProjectInput, identity?: Pick<Bundle, "id" | "revision">) {
  const { files, ...metadata } = project;
  await writeFile(
    join(directory, "kit.json"),
    JSON.stringify(
      {
        ...metadata,
        ...(identity ? { id: identity.id, revision: identity.revision } : {}),
        files: files.map((f) => f.path),
      },
      null,
      2,
    ) + "\n",
  );
}
