import { parse, type Node, type Property } from "acorn";
import { ProjectValidationError } from "./errors";
export { ProjectValidationError } from "./errors";
import { LIMITS, ProjectInput, type Entry, type SourceFile } from "./contracts";
export const isPage = (path: string) => path.endsWith(".md");
export const isNavigationFile = (path: string) => isPage(path) || path.endsWith(".script.js");
export function inspect(file: SourceFile) {
  if (isPage(file.path)) {
    const heading = file.content.match(/^# +(.+?) *#* *$/m)?.[1]?.trim();
    return { entry: { path: file.path, name: (heading || file.path.split("/").at(-1)!.slice(0, -3)).slice(0, 120), icon: "ti ti-file-text", order: 0 }, imports: [] as string[] };
  }
  const tree = parseFile(file);
  let entry: Entry | undefined;
  const imports: string[] = [];
  for (const statement of tree.body) {
    if (statement.type === "ImportDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" && statement.source)) {
      const source = statement.source;
      if (source && typeof source.value === "string")
        imports.push(source.value);
    }
    if (!file.path.endsWith(".script.js") || statement.type !== "ExportDefaultDeclaration")
      continue;
    const call = statement.declaration;
    if (call.type !== "CallExpression" ||
      call.callee.type !== "MemberExpression" ||
      call.callee.computed ||
      call.callee.object.type !== "Identifier" ||
      call.callee.object.name !== "kit" ||
      call.callee.property.type !== "Identifier" ||
      call.callee.property.name !== "script" ||
      call.arguments.length !== 1 ||
      call.arguments[0]?.type !== "ObjectExpression")
      throw new ProjectValidationError("definition", "", file.path);
    const fields = new Map<string, Property>();
    for (const prop of call.arguments[0].properties) {
      if (prop.type !== "Property" || prop.computed || prop.kind !== "init" || prop.key.type !== "Identifier" || fields.has(prop.key.name))
        throw new ProjectValidationError("keys", "", file.path);
      fields.set(prop.key.name, prop);
    }
    if ([...fields.keys()].some((k) => !["name", "icon", "order", "run"].includes(k)))
      throw new ProjectValidationError("metadata", "", file.path);
    const literal = (key: string) => {
      const v = fields.get(key)?.value;
      if (!v)
        return undefined;
      if (v.type !== "Literal")
        throw new ProjectValidationError("literal", key, file.path);
      return v.value;
    };
    const name = literal("name"), icon = literal("icon") ?? "ti ti-code", order = literal("order") ?? 0;
    const run = fields.get("run")?.value;
    if (typeof name !== "string" ||
      !name.trim() ||
      name.length > 120 ||
      typeof icon !== "string" ||
      !/^ti ti-[a-z0-9-]+$/.test(icon) ||
      typeof order !== "number" ||
      !Number.isFinite(order) ||
      !run ||
      !["FunctionExpression", "ArrowFunctionExpression"].includes(run.type))
      throw new ProjectValidationError("metadata", "name, icon, order, run", file.path);
    entry = { path: file.path, name, icon, order };
  }
  // Dynamic imports are excluded: only the declared, verified local graph is bundled.
  function walk(value: unknown): void {
    if (!value || typeof value !== "object")
      return;
    if ("type" in value && value.type === "ImportExpression")
      throw new ProjectValidationError("dynamic", "", file.path);
    for (const child of Object.values(value))
      if (Array.isArray(child))
        child.forEach(walk);
      else if (child && typeof child === "object")
        walk(child);
  }
  walk(tree);
  if (file.path.endsWith(".script.js") && !entry)
    throw new ProjectValidationError("entry", "", file.path);
  return { entry, imports };
}
export function resolveImport(from: string, specifier: string) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    throw new ProjectValidationError("relative", specifier, from);
  const parts = from.split("/").slice(0, -1);
  for (const p of specifier.split("/")) {
    if (p === ".")
      continue;
    if (p === "..") {
      if (!parts.length)
        throw new ProjectValidationError("escape", specifier, from);
      parts.pop();
    }
    else
      parts.push(p);
  }
  const path = parts.join("/");
  if (!path.endsWith(".js"))
    throw new ProjectValidationError("extension", specifier, from);
  return path;
}
function validate(input: unknown) {
  const project = ProjectInput.parse(input);
  const paths = new Set<string>();
  let bytes = 0;
  const entries: Entry[] = [];
  for (const f of project.files) {
    if (paths.has(f.path))
      throw new ProjectValidationError("duplicate", "", f.path);
    paths.add(f.path);
    const n = new TextEncoder().encode(f.content).length;
    if (n > LIMITS.fileBytes)
      throw new ProjectValidationError("fileSize", "", f.path);
    bytes += n;
  }
  if (bytes > LIMITS.sourceBytes)
    throw new ProjectValidationError("projectSize");
  for (const f of project.files) {
    const { entry, imports } = inspect(f);
    if (entry)
      entries.push(entry);
    for (const spec of imports) {
      const p = resolveImport(f.path, spec);
      if (!paths.has(p))
        throw new ProjectValidationError("missing", p, f.path);
    }
  }
  if (!entries.length)
    throw new ProjectValidationError("noEntries");
  return {
    project,
    entries: entries.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path)),
  };
}
export function validateProject(input: unknown) {
  try {
    return validate(input);
  }
  catch (error) {
    if (error instanceof ProjectValidationError)
      throw error;
    throw new ProjectValidationError("input");
  }
}
function parseFile(file: SourceFile) {
  try {
    return parse(file.content, { ecmaVersion: "latest", sourceType: "module", locations: true });
  }
  catch (error) {
    throw new ProjectValidationError("syntax", error instanceof Error ? error.message : "", file.path);
  }
}
/** Keep file identities visible while their author is typing incomplete code. */
export function discoverEntries(files: SourceFile[], previous: Entry[] = []): Entry[] {
  return files.filter(file => isNavigationFile(file.path)).map(file => {
    try {
      return inspect(file).entry!;
    }
    catch {
      return previous.find(entry => entry.path === file.path) ?? { path: file.path, name: file.path, icon: "ti ti-code", order: 0 };
    }
  }).sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
}
export function renameProjectFile(files: SourceFile[], from: string, to: string): SourceFile[] {
  if (isPage(from) && isPage(to)) return files.map(file => file.path === from ? { ...file, path: to } : file);
  // Parse every file before applying any edit. Rewriting text heuristically could change strings or comments.
  return files.map(file => {
    if (isPage(file.path)) return { ...file, path: file.path === from ? to : file.path };
    const tree = parseFile(file);
    const nextPath = file.path === from ? to : file.path;
    const edits: {
      start: number;
      end: number;
      value: string;
    }[] = [];
    for (const statement of tree.body) {
      if (statement.type !== "ImportDeclaration" && statement.type !== "ExportAllDeclaration" && statement.type !== "ExportNamedDeclaration")
        continue;
      const source = statement.source;
      if (!source || typeof source.value !== "string")
        continue;
      const target = resolveImport(file.path, source.value);
      const nextTarget = target === from ? to : target;
      if (nextPath === file.path && nextTarget === target)
        continue;
      const base = nextPath.split("/").slice(0, -1), dest = nextTarget.split("/");
      while (base.length && dest.length && base[0] === dest[0]) {
        base.shift();
        dest.shift();
      }
      const relative = "../".repeat(base.length) + dest.join("/");
      edits.push({ start: source.start, end: source.end, value: JSON.stringify(relative.startsWith("../") ? relative : "./" + relative) });
    }
    let content = file.content;
    for (const edit of edits.reverse())
      content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
    return { path: nextPath, content };
  });
}
