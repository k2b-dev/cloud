import type { Context, ValidationTargets } from "hono";
import { validator as honoValidator } from "hono-openapi";
import type { ZodType } from "zod";

export type ValidatorError = Readonly<{
  code: string;
  message: string;
}>;

export type ValidatorErrorResolver = (context: Context) => ValidatorError;

/**
 * Zod validator middleware with pretty error messages and OpenAPI support.
 * Uses hono-openapi validator for automatic OpenAPI schema generation.
 *
 * @param target - Where to validate: "json", "query", "param", "header", "cookie", or "form"
 * @param schema - Zod schema to validate against
 * @param resolveError - Optional request-scoped application error resolver
 * @returns Hono middleware that validates request data and returns 400 on failure
 *
 * @example
 * ```ts
 * app.post("/users", v("json", CreateUserSchema), async (c) => {
 *   const data = c.req.valid("json"); // Fully typed!
 *   // ...
 * });
 * ```
 */
export const validator = <Target extends keyof ValidationTargets, T extends ZodType>(
  target: Target,
  schema: T,
  resolveError?: ValidatorErrorResolver,
) =>
  honoValidator(target, schema, (result, c: Context) => {
    if (!result.success) {
      if (resolveError) return c.json(resolveError(c), 400);

      // Standard Schema returns issues array on failure
      const errorMessage = result.error
        ?.map((issue) => {
          const path = issue.path?.map((p) => (typeof p === "object" && "key" in p ? String(p.key) : String(p))).join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join(", ");
      return c.json({ message: errorMessage || "Validation failed" }, 400);
    }
  });

export const v = validator;
