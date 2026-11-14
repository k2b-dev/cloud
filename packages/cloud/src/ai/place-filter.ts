import { z } from "zod";
import { CloudResourceRefSchema } from "../contracts/resource-reference";
import type { AiConversationPlaceFilter } from "./types";

/** The first colon separates the type from an app-owned identifier, which may itself contain colons. */
export const AiConversationPlaceFilterSchema = z.string().pipe(
  z.custom<AiConversationPlaceFilter>((value) => {
    if (typeof value !== "string") return false;
    if (value === "none" || value === "any") return true;
    const colon = value.indexOf(":");
    return colon > 0 && CloudResourceRefSchema.safeParse({ type: value.slice(0, colon), id: value.slice(colon + 1) }).success;
  }, "Expected none, any, or a namespaced type:id place reference."),
);
