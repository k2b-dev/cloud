import {
  type AuthContext,
  auth,
  getLocale,
  jsonResponse,
  middleware,
  REQUEST_IDLE_TIMEOUT_MAX_SECONDS,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  setRequestTimeout,
} from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type CodeContext, CodeDataError, CodeOwnerUnavailableError } from "../code/access";
import { codeAuthoringServices } from "../code/authoring";
import {
  CODE_AUTHORING_REQUEST_BYTES,
  type CodeAuthoringError,
  CodeAuthoringErrorSchema,
  codeAuthoringContracts,
} from "../code/authoring-contracts";
import { CodeJobError } from "../code/job-errors";
import { CodeVersionError } from "../code/versions";

/** One versioned failure for HTTP, CLI and chat. Unexpected exceptions keep their diagnostics in server logs. */
export function codeAuthoringFailure(error: unknown): { status: 400 | 403 | 404 | 409 | 503 | 500; body: CodeAuthoringError } {
  if (error instanceof CodeVersionError)
    return {
      status: 409,
      body: { version: 1, error: { code: error.code, message: error.message, details: z.json().parse(error.details ?? null) } },
    };
  if (error instanceof CodeDataError)
    return {
      status: error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400,
      body: { version: 1, error: { code: error.code, message: error.message, details: null } },
    };
  if (error instanceof CodeJobError)
    return { status: 503, body: { version: 1, error: { code: error.code, message: error.message, details: null } } };
  if (error instanceof CodeOwnerUnavailableError)
    return {
      status: 503,
      body: { version: 1, error: { code: "code_owner_unavailable", message: "Code owner unavailable. Retry the command.", details: null } },
    };
  return {
    status: 500,
    body: {
      version: 1,
      error: {
        code: "code_authoring_failed",
        message: "Code command failed. Read the current state before retrying a write.",
        details: null,
      },
    },
  };
}
/** Core authoring transport. Checks/tests use Runner jobs; production writes keep each owning service's guards. */
export function createCodeAuthoringRoutes() {
  const router = new Hono<AuthContext>();
  router.use("*", middleware.noTransform(), auth.requireRole("authenticated"));
  router.use(
    "*",
    bodyLimit({
      maxSize: CODE_AUTHORING_REQUEST_BYTES,
      onError: (c) =>
        c.json(
          { version: 1, error: { code: "code_job_request_limit", message: "Code request exceeds the checker budget.", details: null } },
          413,
        ),
    }),
  );
  function register<I, O>(
    name: string,
    contract: { input: z.ZodType<I>; data: z.ZodType<O> },
    service: (input: I, context: CodeContext) => Promise<O>,
    write = false,
  ) {
    router.post(
      `/${name}`,
      write ? auth.requireOAuthScope("write", "admin") : auth.readOnly,
      middleware.openapi({
        tags: ["Code"],
        summary: `Code ${name}`,
        requestBody: { required: true, ...jsonResponse(contract.input, "Code command input") },
        responses: {
          200: jsonResponse(contract.data, "Code command result"),
          400: jsonResponse(CodeAuthoringErrorSchema, "Invalid Code input"),
          409: jsonResponse(CodeAuthoringErrorSchema, "Version or state conflict"),
          503: jsonResponse(CodeAuthoringErrorSchema, "Runner or owner unavailable"),
        },
      }),
      async (c) => {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
        try {
          if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
            throw new CodeDataError("BAD_INPUT", "Send application/json.");
          const context: CodeContext = {
            authority: auth.getAuthority(c),
            locale: getLocale(c),
            signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000)]),
          };
          let input: I;
          try {
            input = contract.input.parse(await c.req.json());
          } catch {
            throw new CodeDataError("BAD_INPUT", "Invalid Code command input.");
          }
          return c.json(contract.data.parse(await service(input, context)));
        } catch (error) {
          const failure = codeAuthoringFailure(error);
          if (failure.status === 500)
            logger("core:code-authoring").error("Code authoring command failed", {
              command: name,
              error:
                name === "secretSet"
                  ? "private secret operation failed"
                  : error instanceof Error
                    ? { name: error.name, message: error.message, stack: error.stack }
                    : "unknown",
            });
          return c.json(failure.body, failure.status);
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        }
      },
    );
  }
  register("init", codeAuthoringContracts.init, codeAuthoringServices.init, true);
  register("pull", codeAuthoringContracts.pull, codeAuthoringServices.pull);
  register("sdk", codeAuthoringContracts.sdk, codeAuthoringServices.sdk, true);
  register("check", codeAuthoringContracts.check, codeAuthoringServices.check, true);
  register("test", codeAuthoringContracts.test, codeAuthoringServices.test, true);
  register("simulate", codeAuthoringContracts.simulate, codeAuthoringServices.simulate, true);
  register("push", codeAuthoringContracts.push, codeAuthoringServices.push, true);
  register("submit", codeAuthoringContracts.submit, codeAuthoringServices.submit, true);
  register("diff", codeAuthoringContracts.diff, codeAuthoringServices.diff);
  register("activate", codeAuthoringContracts.activate, codeAuthoringServices.activate, true);
  register("run", codeAuthoringContracts.run, codeAuthoringServices.run, true);
  register("pullAll", codeAuthoringContracts.pullAll, codeAuthoringServices.pullAll);
  register("status", codeAuthoringContracts.status, codeAuthoringServices.status);
  register("runs", codeAuthoringContracts.runs, codeAuthoringServices.runs);
  register("runRead", codeAuthoringContracts.runRead, codeAuthoringServices.runRead);
  register("pause", codeAuthoringContracts.pause, codeAuthoringServices.pause, true);
  register("resume", codeAuthoringContracts.resume, codeAuthoringServices.resume, true);
  register("policyRead", codeAuthoringContracts.policyRead, codeAuthoringServices.policyRead);
  register("policyEffective", codeAuthoringContracts.policyEffective, codeAuthoringServices.policyEffective);
  register("policyPreview", codeAuthoringContracts.policyPreview, codeAuthoringServices.policyPreview);
  register("policyUpdate", codeAuthoringContracts.policyUpdate, codeAuthoringServices.policyUpdate, true);
  register("secretSet", codeAuthoringContracts.secretSet, codeAuthoringServices.secretSet, true);
  register("secretList", codeAuthoringContracts.secretList, codeAuthoringServices.secretList);
  register("secretDelete", codeAuthoringContracts.secretDelete, codeAuthoringServices.secretDelete, true);
  return router;
}
