import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { CODE_CHECK_LIMITS } from "@k2b/cloud/code";
import { type CodeProject, CodeProjectSchema } from "../code/authoring-contracts";
import { type CodeOwner, CodeSourceFilesSchema } from "../code/contracts";

const segment = (value: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Owner ID is not a short filesystem-safe resource ID.");
  return value;
};
/** Never derive filenames from a title, email address or display name. */
export function codeProjectFolder(config: CodeProject): string {
  const owner = config.owner;
  return owner.kind === "person"
    ? join("me", config.codeId)
    : owner.kind === "app"
      ? join(segment(owner.appId), config.codeId)
      : join(segment(owner.ref.type.split(".")[0]!), segment(owner.ref.id));
}
/** Refuse links in every managed path, including an existing ancestor outside the project. */
export async function assertCodePath(path: string) {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed in Code workspaces.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
/** Refuse an unsafe owner or an existing deterministic resource checkout before creating remote Code. */
export async function assertCodeDestination(root: string, owner?: CodeOwner) {
  await assertCodePath(resolve(root));
  if (owner?.kind === "app") segment(owner.appId);
  if (owner?.kind !== "resource") return;
  const target = resolve(root, segment(owner.ref.type.split(".")[0]!), segment(owner.ref.id));
  await assertCodePath(target);
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("The resource's local Code folder already exists. Choose a new --out directory.");
}
export async function loadCodeProject(path = ".") {
  let directory = resolve(path);
  await assertCodePath(directory);
  if ((await lstat(directory)).isFile()) directory = dirname(directory);
  while (true) {
    const configFile = join(directory, "code.json");
    try {
      await assertCodePath(configFile);
      const config = CodeProjectSchema.parse(JSON.parse(await readFile(configFile, "utf8")));
      CodeSourceFilesSchema.parse({ [config.entry]: "" });
      return { directory, config };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("No code.json found. Run cld code init or pull first.");
    directory = parent;
  }
}
const ignored = new Set([".git", "node_modules", "sdk", "test", "dist", "build"]);
/** Collect source without evaluating it. Stop at the checker's public file/UTF-8 budget. */
export async function readCodeFiles(directory: string, tests = false) {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function visit(folder: string) {
    for (const item of (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (item.name.startsWith(".") || (!tests && folder === directory && ignored.has(item.name))) continue;
      const path = join(folder, item.name);
      if (item.isSymbolicLink()) throw new Error("Symbolic links are not allowed in Code source.");
      if (item.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!item.isFile() || !(tests ? item.name.endsWith(".json") : /\.tsx?$/.test(item.name))) continue;
      const stat = await lstat(path);
      if ((!tests && Object.keys(files).length >= CODE_CHECK_LIMITS.files) || bytes + stat.size > CODE_CHECK_LIMITS.requestBytes)
        throw new Error("Local Code files exceed the checker request budget.");
      const text = await readFile(path, "utf8");
      bytes += Buffer.byteLength(text);
      if (bytes > (tests ? CODE_CHECK_LIMITS.requestBytes : CODE_CHECK_LIMITS.sourceBytes))
        throw new Error("Local Code source exceeds the checker source budget.");
      files[relative(directory, path).split("\\").join("/")] = text;
    }
  }
  if (tests) {
    const folder = join(directory, "test");
    await assertCodePath(folder);
    try {
      await visit(folder);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  } else await visit(directory);
  return CodeSourceFilesSchema.parse(files);
}
/** New pulls never overwrite a local folder. Use a new --out directory to inspect and reconcile changes. */
export async function writeCodeProject(root: string, config: CodeProject, files: Record<string, string>) {
  const directory = resolve(root, codeProjectFolder(config));
  await assertCodePath(directory);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // EEXIST protects unsaved local edits and concurrent pulls.
  for (const [path, content] of Object.entries(CodeSourceFilesSchema.parse(files))) {
    if (path === "code.json" || path === "tsconfig.json" || path.startsWith("sdk/")) throw new Error(`Reserved project path: ${path}`);
    const target = join(directory, path);
    await assertCodePath(target);
    await mkdir(dirname(target), { recursive: true });
    const file = await open(target, "wx", 0o600);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
  }
  await saveCodeProject(directory, config);
  return directory;
}
export async function saveCodeProject(directory: string, config: CodeProject) {
  const path = join(directory, "code.json");
  await assertCodePath(path);
  const temporary = join(directory, `.code-${crypto.randomUUID()}.json`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(CodeProjectSchema.parse(config), null, 2) + "\n");
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
/** SDK files are generated assets. Refuse links and replace only the fixed SDK paths. */
export async function writeCodeSdk(directory: string, files: Record<string, string>) {
  const allowed = new Set(["sdk/sdk.d.ts", "sdk/sdk.js", "sdk/manifest.json", "tsconfig.json"]);
  for (const [path, content] of Object.entries(files)) {
    if (!allowed.has(path)) throw new Error(`Unexpected SDK path: ${path}`);
    const target = join(directory, path);
    await assertCodePath(target);
    await mkdir(dirname(target), { recursive: true });
    const file = await open(target, "w", 0o600);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
  }
}
/** Discover local projects without traversing links, dependencies or generated output. A project is a traversal boundary. */
export async function listCodeProjects(root = "code") {
  const projects: Awaited<ReturnType<typeof loadCodeProject>>[] = [];
  async function visit(directory: string) {
    await assertCodePath(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const config = entries.find((entry) => entry.name === "code.json");
    if (config) {
      if (!config.isFile()) throw new Error("code.json must be a regular file.");
      projects.push(await loadCodeProject(directory));
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in Code workspaces.");
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  }
  await visit(resolve(root));
  projects.sort((a, b) => (a.config.codeId < b.config.codeId ? -1 : a.config.codeId > b.config.codeId ? 1 : 0));
  if (new Set(projects.map((project) => project.config.codeId)).size !== projects.length)
    throw new Error("Duplicate local Code IDs. Select one checkout root.");
  return projects;
}
