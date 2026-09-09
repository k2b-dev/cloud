import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, jsonResponse } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import { FormSubmitSchema, PublicFormSchema, type SubmitFormDeps, submitFormResponse, toPublicForm } from "./form-api-shared";
import { apiMessages } from "./messages";
import { v } from "./validator";

type PublicFormRoutesDeps = SubmitFormDeps & {
  getByPublicToken?: typeof gridsService.form.getByPublicToken;
  projectForm?: typeof toPublicForm;
};

export const createPublicFormRoutes = (deps: PublicFormRoutesDeps = {}) =>
  new Hono<AuthContext>()
    .get(
      "/public/:token",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Fetch a public form by its share token (anonymous)",
        responses: {
          200: jsonResponse(PublicFormSchema, "Public form (sensitive fields stripped)"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (context) => {
        const form = await (deps.getByPublicToken ?? gridsService.form.getByPublicToken)(context.req.param("token")!);
        if (!form) return context.json({ message: apiMessages(context).formNotFound }, 404);
        return context.json(await (deps.projectForm ?? toPublicForm)(form));
      },
    )
    .post(
      "/public/:token/submit",
      describeRoute({
        tags: ["Grids:Form"],
        summary: "Submit a public form (anonymous, no auth required)",
        responses: {
          201: jsonResponse(z.object({ recordId: ShortIdSchema }), "Created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid input"),
          403: jsonResponse(ErrorResponseSchema, "Record changes from Forms are not allowed"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", FormSubmitSchema),
      async (context) => {
        const form = await (deps.getByPublicToken ?? gridsService.form.getByPublicToken)(context.req.param("token")!);
        if (!form) return context.json({ message: apiMessages(context).formNotFound }, 404);
        return submitFormResponse(context, form, context.req.valid("json"), null, deps);
      },
    );

export const publicFormRoutes = createPublicFormRoutes();
