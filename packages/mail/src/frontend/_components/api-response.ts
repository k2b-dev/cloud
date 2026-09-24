export const readApiError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Preserve the operation-specific fallback for non-JSON failures.
  }
  return fallback;
};

/** A failed Mail API call that keeps the server's stable error code for callers that react to it. */
export class MailApiError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = "MailApiError";
    this.code = code;
  }
}

export const readApiFailure = async (response: Pick<Response, "json">, fallback: string): Promise<MailApiError> => {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const message = "message" in body && typeof body.message === "string" ? body.message : fallback;
      const code = "code" in body && typeof body.code === "string" ? body.code : null;
      return new MailApiError(message, code);
    }
  } catch {
    // Preserve the operation-specific fallback for non-JSON failures.
  }
  return new MailApiError(fallback, null);
};

/** Synchronization or another provider operation holds the account; the same request can simply be retried. */
export const isProviderBusy = (error: unknown): boolean => error instanceof MailApiError && error.code === "PROVIDER_BUSY";
