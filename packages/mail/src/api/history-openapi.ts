import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { jsonResponse, requiresAuth } from "@k2b/cloud/server";
import { describeRoute } from "hono-openapi";
import type { z } from "zod";

const errorResponses = {
  400: jsonResponse(ErrorResponseSchema, "Invalid request"),
  401: jsonResponse(ErrorResponseSchema, "Authentication required"),
  403: jsonResponse(ErrorResponseSchema, "Forbidden"),
  404: jsonResponse(ErrorResponseSchema, "Not found"),
  409: jsonResponse(ErrorResponseSchema, "Conflict"),
  500: jsonResponse(ErrorResponseSchema, "Internal server error"),
};
type ErrorStatus = keyof typeof errorResponses;

export const historyOperation = <T extends z.ZodType>(
  summary: string,
  successSchema: T,
  successDescription: string,
  additionalErrors: readonly Exclude<ErrorStatus, 400 | 401 | 403 | 500>[] = [],
) =>
  describeRoute({
    tags: ["Mail:History"],
    summary,
    ...requiresAuth,
    responses: {
      200: jsonResponse(successSchema, successDescription),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      500: errorResponses[500],
      ...Object.fromEntries(additionalErrors.map((status) => [status, errorResponses[status]])),
    },
  });
