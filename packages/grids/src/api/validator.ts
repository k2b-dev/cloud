import { v as cloudValidator } from "@valentinkolb/cloud/server";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { apiMessages } from "./messages";

export const v = <Target extends keyof ValidationTargets, T extends ZodType>(target: Target, schema: T) =>
  cloudValidator(target, schema, (context) => ({
    code: "VALIDATION_FAILED",
    message: apiMessages(context).invalidRequest,
  }));
