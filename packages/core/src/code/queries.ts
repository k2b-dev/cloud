import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { ZodError } from "zod";
import { type CodeContext, CodeDataError, CodeOwnerUnavailableError } from "./access";
import { CodeVersionError } from "./versions";

const contextFor = (context: CapabilityExecutionContext): CodeContext => {
  if (!context.authority) throw new CodeDataError("FORBIDDEN", "Code requires request authority.");
  return { authority: context.authority, locale: context.locale, signal: context.signal, requestId: context.requestId };
};
export async function runCodeQuery<T>(context: CapabilityExecutionContext, run: (context: CodeContext) => Promise<T>) {
  try {
    return ok({ data: await run(contextFor(context)) });
  } catch (error) {
    if (error instanceof ZodError) return fail(err.badInput("Invalid Code input."));
    if (error instanceof CodeVersionError)
      return fail({
        code: error.code,
        message: error.message,
        status: error.code === "code_sends_not_yet" || error.code === "code_manifest_invalid" ? (400 as const) : (409 as const),
        ...(error.details ? { details: error.details } : {}),
      });
    if (error instanceof CodeOwnerUnavailableError)
      return fail(err.internal("Code owner is unavailable. Try again after its application recovers."));
    if (!(error instanceof CodeDataError)) throw error;
    if (error.code === "FORBIDDEN") return fail(err.forbidden(error.message));
    if (error.code === "NOT_FOUND") return fail(err.notFound("Code"));
    if (error.code === "CONFLICT") return fail(err.conflict(error.message));
    return fail(err.badInput(error.message));
  }
}
