import { BATCH_LIMIT } from "../contracts";

export type CommaMode = "split" | "literal";
export type FolderIssue = "empty" | "dot" | "spaces" | "name_length" | "path_length" | "character" | "reserved" | "duplicate";
export type PlannedFolder = { name: string; path: string; depth: number; issue: FolderIssue | null };
export type FolderPlan = { folders: PlannedFolder[]; comma: boolean; tooMany: boolean; valid: boolean };

export function planFolders(input: string, options: { parent: string; commas: CommaMode }): FolderPlan {
  if (!input) return { folders: [], comma: false, tooMany: false, valid: false };
  const segments = input.split("/");
  const last = segments.pop()!;
  const comma = last.includes(",");
  const siblings = comma && options.commas === "split" ? last.split(",").map((name) => name.trim()) : [last];
  const folders: PlannedFolder[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, depth: number, duplicate: boolean) => {
    let issue: FolderIssue | null = null;
    if (!name) issue = "empty";
    else if (name === "." || name === "..") issue = "dot";
    else if (name.trim() !== name) issue = "spaces";
    else if (name.length > 255) issue = "name_length";
    else if (/[\\\x00-\x1f\x7f]/.test(name)) issue = "character";
    else if (name === ".filegate" || (name === "trash" && !options.parent && depth === 0)) issue = "reserved";
    else if (duplicate) issue = "duplicate";
    else if (path.length > 4096) issue = "path_length";
    folders.push({ name, path, depth, issue });
  };
  const prefix = options.parent ? [options.parent] : [];
  for (const [depth, name] of segments.entries()) {
    prefix.push(name);
    const path = prefix.join("/");
    add(name, path, depth, false);
  }
  for (const name of siblings) {
    add(name, [...prefix, name].join("/"), segments.length, seen.has(name));
    seen.add(name);
  }
  const tooMany = folders.length > BATCH_LIMIT;
  return { folders, comma, tooMany, valid: folders.length > 0 && !tooMany && folders.every((folder) => folder.issue === null) };
}
