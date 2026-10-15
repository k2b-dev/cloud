import { type CloudCliContext, cliText } from "@k2b/cloud/cli";

export const REQUEST_TIMEOUT_MS = 60_000;

export function cloudRequestError(ctx: Pick<CloudCliContext, "options">, error: unknown): never {
  if (error instanceof DOMException && error.name === "TimeoutError")
    throw new Error(
      cliText(ctx, {
        en: "No response from Cloud within 60 seconds.",
        de: "Keine Antwort von Cloud innerhalb von 60 Sekunden.",
      }),
    );
  throw error;
}
