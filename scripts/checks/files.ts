import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import type { Finding } from "./rule";

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

/** The text of a parse diagnostic, whether TypeScript gives it as a string or as a chain. */
const diagnosticText = (message: unknown): string | null => {
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && "messageText" in message) return diagnosticText(message.messageText);
  return null;
};

/**
 * Parses source in the grammar its extension names: TSX for `.tsx`, TS for everything else. Parsed as TSX, a generic
 * arrow function in a `.ts` file (`<T>(value: T) => …`) reads as a JSX tag, and the rest of the file is never visited.
 * A file that still does not parse comes back as a finding, so a rule never stops checking a file silently.
 */
export const parseSource = (file: string, source: string): { sourceFile: ts.SourceFile; findings: Finding[] } => {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  // TypeScript keeps syntax errors on the source file without a public accessor; read them checked.
  const diagnostics: unknown = Reflect.get(sourceFile, "parseDiagnostics");
  const first: unknown = Array.isArray(diagnostics) ? diagnostics[0] : undefined;
  if (!first || typeof first !== "object" || !("start" in first) || typeof first.start !== "number") return { sourceFile, findings: [] };
  const text = "messageText" in first ? diagnosticText(first.messageText) : null;
  return {
    sourceFile,
    findings: [
      {
        file,
        line: sourceFile.getLineAndCharacterOfPosition(first.start).line + 1,
        message: `Does not parse as ${kind === ts.ScriptKind.TSX ? "TSX" : "TS"} (${text ?? "syntax error"}), so the rule cannot check the rest of this file`,
      },
    ],
  };
};
