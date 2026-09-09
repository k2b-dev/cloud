import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAiTextEditorInput, CloudAiTextEditorOutput } from "@k2b/cloud/ai";
import { CLOUD_AI_TEXT_EDITOR_MAX_CHARS } from "@k2b/cloud/ai/browser";

export const parseEditorCommand = (value: string): string[] | null => {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      continue;
    }
    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      continue;
    }
    if (/\s/u.test(char) && quote === null) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped || quote !== null) return null;
  if (current) args.push(current);
  return args.length > 0 ? args : null;
};

const runEditor = async (command: string[], path: string): Promise<number> => {
  const process = Bun.spawn([...command, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return process.exited;
};

export const editTextWithExternalEditor = async (
  input: CloudAiTextEditorInput,
  options: {
    editor?: string;
    run?: (command: string[], path: string) => Promise<number>;
  } = {},
): Promise<CloudAiTextEditorOutput> => {
  const editor = options.editor ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editor?.trim()) throw new Error("Set VISUAL or EDITOR to edit long text in the terminal.");
  const command = parseEditorCommand(editor);
  if (!command) throw new Error("VISUAL or EDITOR contains an invalid command.");
  const directory = await mkdtemp(join(tmpdir(), "cloud-text-editor-"));
  const path = join(directory, input.format === "markdown" ? "draft.md" : "draft.txt");
  try {
    await writeFile(path, input.content, "utf8");
    const exitCode = await (options.run ?? runEditor)(command, path);
    if (exitCode !== 0) throw new Error(`Editor exited with code ${exitCode}.`);
    const content = await readFile(path, "utf8");
    if (content.length > CLOUD_AI_TEXT_EDITOR_MAX_CHARS) {
      throw new Error(`Edited text exceeds the ${CLOUD_AI_TEXT_EDITOR_MAX_CHARS.toLocaleString()} character limit.`);
    }
    return { submitted: true, content, format: input.format };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
