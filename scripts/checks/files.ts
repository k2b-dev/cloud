import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const skippedDirectories = new Set(["node_modules", "dist", "build", "_ssr", ".local"]);

/** Recursively lists files below `dir` whose name matches `pattern`, skipping build outputs. */
export const listFiles = (dir: string, pattern: RegExp, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) listFiles(path, pattern, out);
      continue;
    }
    if (entry.isFile() && pattern.test(entry.name)) out.push(path);
  }
  return out;
};

export const sourceFilePattern = /\.(?:ts|tsx)$/;

export const isTestFile = (path: string): boolean => /\.(?:test|spec)\.(?:ts|tsx)$/.test(path);

export const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();
