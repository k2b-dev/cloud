import { z } from "zod";
export const ContactComposeInputSchema = z
  .object({
    bookId: z.string().min(1).max(100).optional().describe("Address book to create the contact in; otherwise choose a writable book."),
  })
  .strict();
