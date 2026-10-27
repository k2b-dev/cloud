import { coreClient } from "@k2b/cloud/clients/core";

export const aiAdminApi = coreClient.admin.core.ai;

/** Someone else saved first. `current` is the stored entry as the API returns it. */
export class AiAdminConflict<T = unknown> extends Error {
  constructor(
    readonly current: T,
    readonly changedBy: { id: string; name: string } | null,
    readonly changedAt: string,
  ) {
    super("conflict");
  }
}

export class AiAdminError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const field = (body: unknown, key: string): unknown =>
  body && typeof body === "object" && key in body ? (body as Record<string, unknown>)[key] : undefined;

/** Reads an API answer: the JSON body on success, a conflict on 409, otherwise an error with the server's message. */
export const readAiAdmin = async <T>(response: { ok: boolean; status: number; json(): Promise<T> }, fallback: string): Promise<T> => {
  if (response.ok) return response.json();
  const body: unknown = await response.json().catch(() => null);
  const code = field(body, "code");
  const message = field(body, "message");
  if (response.status === 409 && code === "conflict") {
    const by = field(body, "changedBy");
    const name = field(by, "name");
    const id = field(by, "id");
    const changedAt = field(body, "changedAt");
    throw new AiAdminConflict(
      field(body, "current"),
      typeof name === "string" && typeof id === "string" ? { id, name } : null,
      typeof changedAt === "string" ? changedAt : "",
    );
  }
  throw new AiAdminError(typeof message === "string" ? message : fallback, typeof code === "string" ? code : undefined);
};

/** The conflict with its stored entry checked against the API contract, or `null` for any other failure. */
export const asAiConflict = <T>(failure: unknown, schema: { parse(value: unknown): T }): AiAdminConflict<T> | null =>
  failure instanceof AiAdminConflict ? new AiAdminConflict(schema.parse(failure.current), failure.changedBy, failure.changedAt) : null;

/** A stable id from a name: lower case, letters, digits, dots, dashes. */
export const aiSlug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 120);

export const reloadAiArea = (href?: string) => {
  window.location.assign(href ?? `${window.location.pathname}${window.location.search}`);
};
