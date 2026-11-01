import { z } from "zod";

/** A failed Code administration request with the server's stable code. */
export class CodeAdminRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

const FailureSchema = z.object({ code: z.string().optional(), message: z.string().optional() });

/** POST JSON to `/api/code/admin/*` and return `data` checked against its contract, or throw with status and code. */
export const postCodeAdmin = async <T extends z.ZodType>(
  path: string,
  body: unknown,
  data: T,
  signal?: AbortSignal,
): Promise<z.output<T>> => {
  const response = await fetch(`/api/code/admin/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = FailureSchema.safeParse(payload);
    throw new CodeAdminRequestError(
      (failure.success && failure.data.message) || response.statusText,
      response.status,
      failure.success ? failure.data.code : undefined,
    );
  }
  const envelope = z.object({ data: z.unknown() }).safeParse(payload);
  const parsed = envelope.success ? data.safeParse(envelope.data.data) : null;
  if (!parsed?.success) throw new CodeAdminRequestError("Unexpected response", response.status, "BAD_RESPONSE");
  return parsed.data;
};

export const reloadCodeArea = (href?: string) => {
  window.location.assign(href ?? `${window.location.pathname}${window.location.search}`);
};
