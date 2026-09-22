import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { InstalledDocumentProfile } from "../document-profiles";
import { documentProfileInputMessage } from "../document-profiles/input-diagnostics";

/** The issuance contract, without rendering artifacts or allocating a number. */
export const validateDocumentProfileInput = (
  profile: InstalledDocumentProfile,
  input: Record<string, unknown>,
  locale?: string,
): Result<Record<string, unknown>> => {
  const parsed = profile.input.safeParse(input);
  if (!parsed.success) return fail(err.badInput(documentProfileInputMessage(profile.id, parsed.error.issues, locale)));
  return ok(input);
};
