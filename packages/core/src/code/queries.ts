import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { type CodeContext, CodeDataError, CodeOwnerUnavailableError } from "./access";

const contextFor = (context: CapabilityExecutionContext): CodeContext => {
  if (!context.authority) throw new CodeDataError("FORBIDDEN", "Code requires request authority.");
  return { authority: context.authority, locale: context.locale, signal: context.signal, requestId: context.requestId };
};
export async function runCodeQuery<T>(context: CapabilityExecutionContext, run: (context: CodeContext) => Promise<T>) {
  try {
    return ok({ data: await run(contextFor(context)) });
  } catch (error) {
    if (error instanceof CodeOwnerUnavailableError)
      return fail(err.internal("Code owner is unavailable. Try again after its application recovers."));
    if (!(error instanceof CodeDataError)) throw error;
    if (error.code === "FORBIDDEN") return fail(err.forbidden(error.message));
    if (error.code === "NOT_FOUND") return fail(err.notFound("Code"));
    if (error.code === "CONFLICT") return fail(err.conflict(error.message));
    return fail(err.badInput(error.message));
  }
}
