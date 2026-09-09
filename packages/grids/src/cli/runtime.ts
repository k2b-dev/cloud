import { writeFile } from "node:fs/promises";
import type { CliInputFlagValue, CloudCliContext } from "@k2b/cloud/cli";
import { flag, printStructured, readCliInput } from "@k2b/cloud/cli";
import type { DslQueryAutocompleteResponse } from "../contracts";
import type { WorkflowAutocompleteResponse } from "../workflows/contracts";

export type MessageResponse = { message?: string };

export const JSON_BODY_INPUT = flag.input({
  name: "body",
  fileName: "body-file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "json",
});

export const queryString = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
};

export const jsonRequest = (method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const readApi = async <T>(ctx: CloudCliContext, path: string, init?: RequestInit): Promise<T> =>
  ctx.readJson<T>(await ctx.fetch(`/api/grids${path}`, init));

export const readApiText = async (ctx: CloudCliContext, path: string): Promise<string> => {
  const response = await ctx.fetch(`/api/grids${path}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.text();
};

export const writeApiFile = async (ctx: CloudCliContext, path: string, init: RequestInit | undefined, out: string | undefined) => {
  if (!out) throw new Error("Missing output path. Pass --out <file>.");
  const response = await ctx.fetch(`/api/grids${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  await writeFile(out, new Uint8Array(await response.arrayBuffer()));
  if (!printStructured(ctx, { path: out })) ctx.print(`Wrote ${out}.`);
};

export const printJsonOrTable = <TRow extends Record<string, unknown>>(
  ctx: CloudCliContext,
  value: unknown,
  rows: TRow[],
  columns: Parameters<CloudCliContext["table"]>[1],
) => {
  if (ctx.options.output === "json") ctx.json(value);
  else if (ctx.options.output === "jsonl") rows.forEach((row) => ctx.jsonLine(row));
  else ctx.table(rows, columns);
};

export const printJsonOrMessage = (ctx: CloudCliContext, value: unknown, message: string) => {
  if (ctx.options.output === "json") ctx.json(value);
  else if (ctx.options.output === "jsonl") ctx.jsonLine(value);
  else ctx.print(message);
};

export const printCliStructured = (ctx: CloudCliContext, value: unknown): boolean => {
  if (ctx.options.output === "json") {
    ctx.json(value);
    return true;
  }
  if (ctx.options.output === "jsonl") {
    ctx.jsonLine(value);
    return true;
  }
  return false;
};

export const printReference = (ctx: CloudCliContext, value: unknown, text: string) => {
  if (ctx.options.output === "json") ctx.json(value);
  else if (ctx.options.output === "jsonl") ctx.jsonLine(value);
  else ctx.print(text);
};

export const requireRestArg = (args: string[], index: number, label: string): string => {
  const value = args[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
};

export const readTextInput = async (input: CliInputFlagValue, label: string, required = true): Promise<string | undefined> => {
  const text = await readCliInput(input, { label, required, trimFinalNewline: true });
  if (required && !text?.trim()) throw new Error(`Missing ${label}.`);
  return text;
};

export const readJsonInput = async <T>(input: CliInputFlagValue, label: string, required = true): Promise<T | undefined> => {
  const text = await readTextInput(input, label, required);
  if (text === undefined || text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${message}`);
  }
};

export const applyDefined = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value;
  }
  return target;
};

export const exactMatch = <T>(
  items: T[],
  ref: string,
  fields: Array<(item: T) => string | null | undefined>,
  label: string,
  format: (item: T) => string,
): T => {
  const exact = items.filter((item) => fields.some((field) => field(item) === ref));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new Error(`Ambiguous ${label} "${ref}". Use one of: ${exact.map(format).join(", ")}`);

  const candidates = items
    .filter((item) => fields.some((field) => (field(item) ?? "").toLowerCase().includes(ref.toLowerCase())))
    .slice(0, 5)
    .map(format)
    .join(", ");
  throw new Error(`Unknown ${label} "${ref}".${candidates ? ` Candidates: ${candidates}.` : ""}`);
};

export const printDiagnostics = (ctx: CloudCliContext, diagnostics: Array<{ message: string; line?: number; column?: number }>) => {
  if (diagnostics.length === 0) {
    ctx.print("No diagnostics.");
    return;
  }
  for (const diagnostic of diagnostics) {
    const location = diagnostic.line && diagnostic.column ? `Line ${diagnostic.line}, col ${diagnostic.column}: ` : "";
    ctx.print(`${location}${diagnostic.message}`);
  }
};

export const printAutocomplete = (ctx: CloudCliContext, payload: DslQueryAutocompleteResponse | WorkflowAutocompleteResponse) => {
  if (ctx.options.output === "json") {
    ctx.json(payload);
    return;
  }
  ctx.table(
    payload.items.map((item) => ({
      label: item.label,
      kind: item.kind,
      detail: item.detail ?? "",
      insertText: item.insertText,
    })),
    [
      { key: "label", label: "LABEL" },
      { key: "kind", label: "KIND" },
      { key: "detail", label: "DETAIL" },
      { key: "insertText", label: "INSERT" },
    ],
  );
  if (payload.diagnostics.length > 0) {
    ctx.print("");
    printDiagnostics(ctx, payload.diagnostics);
  }
};
