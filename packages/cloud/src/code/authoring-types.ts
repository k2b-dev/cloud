/** A target identity created by a generated factory, never an authorization grant. */
declare const __codeHandle: unique symbol;
export type CodeHandle<Type extends string, Id extends string = string> = {
  readonly [__codeHandle]: Type;
  readonly type: Type;
  readonly id: Id;
};
type CodeNonLiteralId<Id extends string> = Id extends unknown ? ({} extends Record<Id, never> ? true : false) : never;
/** Resource Code accepts only finite string literal unions, including const tuples and imported constants. */
export type CodeLiteralId<Id extends string> = Id & (true extends CodeNonLiteralId<Id> ? never : unknown);
/** Core resolves the current person and groups before dispatching a future route. */
export type CodeUser = { id: string; groups: string[] };
/** Basic request helpers for future routes. No middleware system is part of Code. */
export type CodeRequest = { raw: Request; param(name: string): string; query(name: string): string | undefined; json(): Promise<unknown> };
/** Authenticated route context. */
export type CodeContext = {
  req: CodeRequest;
  user: CodeUser;
  json(value: unknown, status?: number): Response;
  text(value: string, status?: number): Response;
  html(value: unknown, status?: number): Response;
  redirect(location: string, status?: number): Response;
};
/** A webhook is anonymous and must verify its request explicitly. */
export type CodeWebhookContext = Omit<CodeContext, "user"> & { verify(secret: string): Promise<boolean> };
/** Future navigation is presentation only; handlers must still authorize requests. */
export type CodeNavigationItem = { title: string; path: string };
/** A synchronous or asynchronous schedule callback, also used for a manual start. */
export type CodeScheduleHandler = () => void | Promise<void>;

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
