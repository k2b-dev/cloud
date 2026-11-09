import type { CodePageBlock } from "./page-authoring-types";

/** Opaque, expiring, single-use file from this run. Only Core can redeem it; it contains no bytes or URL. */
declare const __codeFileRef: unique symbol;
export type FileRef = {
  readonly [__codeFileRef]: true;
  readonly id: string;
  readonly name?: string;
  readonly mediaType: string;
  readonly size: number;
};

/** A generated SDK method bound to its application and optional resource. Only accepted in AI tools arrays. */
declare const __codeAiTool: unique symbol;
export type CodeAiTool = { readonly [__codeAiTool]: true };

/** A target identity created by a generated factory, never an authorization grant. */
declare const __codeHandle: unique symbol;
export type CodeHandle<Type extends string, Id extends string = string> = {
  readonly [__codeHandle]: Type;
  readonly type: Type;
  readonly id: Id;
};
/** Query data and the capability envelope's optional pagination, shared by queries returning domain data. */
export type CodeQueryResult<Data> = {
  data: Data;
  page?: { hasMore: true; nextCursor: string } | { hasMore: false };
};
/** Visitor identity is presentation and handler input, never the authority for SDK data calls. */
export type CodeUser = {
  id: string;
  /** Cloud login handle, distinct from the immutable user ID. */
  username: string;
  groupIds: string[];
  groupNames: string[];
  /** The signed-in person's Cloud account profile. Workload accounts cannot visit private pages. */
  kind: "user" | "guest";
  name: string;
};
/** Request helpers for hosted routes. */
export type CodeRequest = {
  raw: Request;
  param(name: string): string;
  query(name: string): string | undefined;
  json(): Promise<unknown>;
  text(): Promise<string>;
  formData(): Promise<FormData>;
};
/** Authenticated route context. */
export type CodeContext<Variables extends object = {}> = {
  /** Request-local variables, declared once on app.use<Variables>(). */
  set<Key extends keyof Variables & string>(key: Key, value: Variables[Key]): void;
  get<Key extends keyof Variables & string>(key: Key): Variables[Key];
  req: CodeRequest;
  user: CodeUser | null;
  json(value: unknown, status?: number): Response;
  text(value: string, status?: number): Response;
  /** Draws a page built from SDK blocks; its root is `<Page>`. */
  page(page: CodePageBlock): Response;
  redirect(location: string, status?: number): Response;
};
/** Call once to run the next matching middleware or route handler. */
export type CodeNext = () => Promise<Response>;
/** Return a response to stop, or call next(); awaiting next() may also return void. */
export type CodeMiddleware<Variables extends object = {}> = (
  c: CodeContext<Variables>,
  next: CodeNext,
) => Response | void | Promise<Response | void>;
/** One schedule occurrence, stable across retries. Manual runs have scheduledAt null. */
export type CodeScheduleContext = { runId: string; scheduledAt: string | null; input: unknown };
export type CodeScheduleHandler = (context: CodeScheduleContext) => void | Promise<void>;
/** A refused SDK call. Codes are lowercase snake_case; status distinguishes forbidden and missing targets. */
export declare class CodeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(code: string, status?: number, message?: string, details?: unknown);
}

/** Opaque header placeholder. It never contains a value; only Core can substitute it at an approved destination. */
declare const __codeSecret: unique symbol;
export type CodeSecret = string & { readonly [__codeSecret]: true };
/** Bounded public HTTPS result. Body is base64, preserving binary bytes; echoed credentials are redacted by Core. */
export type CodeHttpResult = { status: number; headers: Record<string, string>; body: string };
export type CodeHttp = {
  /** Declare exact HTTPS origins for dynamic URLs and redirects. Literal array; never grants runtime authority. */
  allow(origins: readonly string[]): void;
  fetch(
    url: string,
    options?: {
      method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<CodeHttpResult>;
};

/** SQLite scalar parameters are sent as bound values, never interpolated into SQL. */
export type CodeDatabaseValue = string | number | boolean | null;
export type CodeDatabaseStatement = { sql: string; params?: readonly CodeDatabaseValue[] };
/** Persistent database owned by this Code, shared across its versions. */
export type CodeDatabase = {
  query<Row = Record<string, CodeDatabaseValue>>(sql: string, params?: readonly CodeDatabaseValue[]): Promise<Row[]>;
  exec(sql: string, params?: readonly CodeDatabaseValue[]): Promise<{ changes: number }>;
  batch(statements: readonly CodeDatabaseStatement[]): Promise<{ changes: number }[]>;
};
