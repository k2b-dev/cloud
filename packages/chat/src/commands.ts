import { z } from "zod";

export const ChatComposeInputSchema = z.strictObject({
  userId: z.uuid().describe("User UUID of the person to select; Chat checks current availability and guest restrictions."),
});
