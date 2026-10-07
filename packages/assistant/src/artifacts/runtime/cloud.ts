import { z } from "zod";
import { createAi } from "./ai";
import { createDownload } from "./download";
import { CloudError, guarded } from "./errors";
import { createHttp } from "./http";
import { boundMoney, chart, html } from "./lib";
import { createPdf } from "./pdf";

type Rpc = (method: string, args?: unknown[], signal?: AbortSignal) => Promise<unknown>;
export type RuntimeContext = { locale: string; timeZone: string; user: { id: string; name: string } | null };
type LazyModules = {
  sheet: typeof import("./sheet-chunk");
  finance: typeof import("./finance-chunk");
  "pdf-read": typeof import("./pdf-reader");
};
export function createCloud(rpc: Rpc, context: RuntimeContext) {
  const chunks = new Map<keyof LazyModules, Promise<unknown>>();
  async function load<K extends keyof LazyModules>(name: K): Promise<LazyModules[K]> {
    let pending = chunks.get(name);
    if (!pending) {
      pending = rpc("runtime.chunk", [name])
        .then(async (code) => {
          if (typeof code !== "string" || /^\s*</.test(code))
            throw new CloudError(
              "unavailable",
              "The runtime library did not return JavaScript; retry or ask the operator to check the runtime assets.",
            );
          const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          try {
            return await import(/* @vite-ignore */ url);
          } finally {
            URL.revokeObjectURL(url);
          }
        })
        .catch((error) => {
          chunks.delete(name);
          throw error;
        });
      chunks.set(name, pending);
    }
    // A module's shape is fixed by the host's allowlisted entry, never by script arguments.
    return pending as Promise<LazyModules[K]>;
  }
  const storage = (scope: "shared" | "user") => ({
    get: (key: string) => rpc("storage", [{ scope, area: "kv", operation: "read", key }]),
    set: (key: string, value: unknown) => rpc("storage", [{ scope, area: "kv", operation: "write", key, value }]),
    delete: (key: string) => rpc("storage", [{ scope, area: "kv", operation: "delete", key }]),
    keys: (page: { after?: string; limit?: number } = {}) =>
      rpc("storage", [{ scope, area: "kv", operation: "list", limit: 100, ...page }]),
  });
  const db = (request: unknown) => rpc("database", [request]);
  const finance =
    <K extends "datev" | "sepa" | "camt" | "einvoice", M extends keyof typeof import("./finance-chunk")[K]>(kind: K, method: M) =>
    async (...args: unknown[]) => {
      const module = await load("finance");
      const fn = module[kind][method];
      if (typeof fn !== "function") throw new CloudError("invalid", "Unknown finance operation.");
      return Reflect.apply(fn, module[kind], args);
    };
  const surface = {
    ...context,
    ai: createAi(rpc),
    http: createHttp(rpc),
    capabilities: {
      run: (name: string, input: unknown = {}) => rpc("capabilities.run", [name, input]),
      streams: {
        read: (ref: unknown) => rpc("capabilities.stream", [ref, "read"]),
        write: (ref: unknown, body: Blob | string | ArrayBuffer | Uint8Array) =>
          rpc("capabilities.stream", [ref, "write", new Blob([body instanceof Uint8Array ? new Uint8Array(body) : body])]),
        status: (ref: unknown) => rpc("capabilities.stream", [ref, "status"]),
        abort: (ref: unknown) => rpc("capabilities.stream", [ref, "abort"]),
      },
    },
    db: {
      list: (
        table: string,
        where: Record<string, string | number | boolean | null> = {},
        options: { order?: string; limit?: number; offset?: number } = {},
      ) => db({ operation: "list", table, where, ...options }),
      get: (table: string, id: number) => db({ operation: "get", table, id }),
      insert: (table: string, rows: unknown) => db({ operation: "insert", table, rows }),
      update: (table: string, id: number, values: unknown) => db({ operation: "update", table, id, values }),
      delete: (table: string, id: number) => db({ operation: "delete", table, id }),
      query: (sql: string, params: unknown[] = []) => db({ operation: "query", sql, params }),
    },
    kv: { ...storage("shared"), user: storage("user") },
    files: {
      read: (path: string) => rpc("storage", [{ scope: "shared", area: "files", operation: "read", key: path }]),
      write: async (path: string, value: Blob | string) => {
        if (typeof value !== "string" && !(value instanceof Blob)) throw new CloudError("invalid", "File data must be a Blob or string.");
        if (new Blob([value]).size > 16 * 1024 * 1024) throw new CloudError("limit", "Files may contain at most 16 MiB; split this file.");
        return rpc("storage", [{ scope: "shared", area: "files", operation: "write", key: path, value }]);
      },
      delete: (path: string) => rpc("storage", [{ scope: "shared", area: "files", operation: "delete", key: path }]),
      list: async () => {
        const paths: string[] = [];
        let after = "";
        for (;;) {
          const parsed = z
            .array(z.string())
            .safeParse(await rpc("storage", [{ scope: "shared", area: "files", operation: "list", after, limit: 1000 }]));
          if (!parsed.success || parsed.data.some((path) => path <= after))
            throw new CloudError("unavailable", "The file listing returned an invalid page.");
          const page = parsed.data;
          paths.push(...page);
          if (page.length < 1000) return paths;
          after = page[page.length - 1]!;
        }
      },
    },
    download: createDownload(rpc),
    html,
    chart: (options: Parameters<typeof chart>[0]) => chart(options, context.locale),
    money: boundMoney(context.locale),
    pdf: { ...createPdf(rpc), read: async (file: Blob) => (await load("pdf-read")).read(file) },
    sheet: {
      parseCsv: async (input: Blob | string, options = {}) => (await load("sheet")).parseCsv(input, options, context.locale),
      toCsv: async (rows: Record<string, unknown>[], options = {}) => (await load("sheet")).toCsv(rows, options, context.locale),
      read: async (file: Blob, options = {}) => (await load("sheet")).read(file, options),
      toOds: async (sheets: Parameters<typeof import("./sheet-chunk").toOds>[0]) => (await load("sheet")).toOds(sheets),
    },
    finance: {
      datev: { validate: finance("datev", "validate"), serialize: finance("datev", "serialize") },
      sepa: { validate: finance("sepa", "validate"), serialize: finance("sepa", "serialize") },
      camt: { parse: finance("camt", "parse") },
      einvoice: {
        validate: finance("einvoice", "validate"),
        calculate: finance("einvoice", "calculate"),
        serialize: finance("einvoice", "serialize"),
        parseXml: finance("einvoice", "parseXml"),
        parsePdf: async (file: Blob, options?: Parameters<typeof import("./finance-chunk").einvoice.parsePdf>[1]) => {
          if (!(file instanceof Blob)) throw new CloudError("invalid", "Expected an invoice PDF Blob.");
          return (await load("finance")).einvoice.parsePdf(new Uint8Array(await file.arrayBuffer()), options ?? {});
        },
      },
    },
  };
  // Freeze every namespace and normalize errors from local helpers as well as RPCs.
  function freeze<T extends object>(value: T): T {
    for (const key of Object.keys(value) as (keyof T)[]) {
      const member = value[key];
      if (typeof member === "function") Object.defineProperty(value, key, { value: guarded(member), enumerable: true });
      else if (member && typeof member === "object") freeze(member);
    }
    return Object.freeze(value);
  }
  return freeze(surface);
}
