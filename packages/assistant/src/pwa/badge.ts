import { countAiOpenQuestions } from "@k2b/cloud/ai";
import { type AuthContext, auth, ok, rateLimit, respond } from "@k2b/cloud/server";
import { Hono } from "hono";

/**
 * The count beside the part in the Cloud app: questions that wait for this person's answer, the same rows as
 * "Waiting for you". A finished answer is marked in the list instead.
 */
export const pwaApi = new Hono<AuthContext>()
  .use(rateLimit())
  .get("/badge", auth.requireRole("authenticated"), auth.requireUser(), async (c) => {
    const subject = c.get("accessSubject");
    return respond(c, ok({ count: subject.type === "user" ? await countAiOpenQuestions(subject.userId) : 0 }));
  });
