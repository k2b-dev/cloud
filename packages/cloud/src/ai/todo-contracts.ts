import { z } from "zod";

/** Bounded working plan, not a project/task database. */
export const AiTodoPlanSchema = z
  .object({
    todos: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-zA-Z0-9_-]+$/)
              .max(80),
            content: z.string().trim().min(1).max(500),
            status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine(({ todos }, ctx) => {
    if (todos.filter((item) => item.status === "in_progress").length > 1)
      ctx.addIssue({ code: "custom", path: ["todos"], message: "At most one task may be in_progress." });
    if (new Set(todos.map((item) => item.id)).size !== todos.length)
      ctx.addIssue({ code: "custom", path: ["todos"], message: "Task IDs must be unique." });
  });
export type AiTodoPlan = z.infer<typeof AiTodoPlanSchema>;
export function parseAiTodoPlan(value: unknown): AiTodoPlan | undefined {
  const parsed = AiTodoPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
