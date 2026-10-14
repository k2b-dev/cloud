import { commandPath, readCommand } from "@k2b/cloud/contracts";
import { MailDraftCalendarInputSchema } from "../commands";
import { mailDraftHref } from "./_components/mail-compose-route";

/** Resolve the fixed Command entry route into the existing permission-checked draft page. */
export const mailCalendarCommandHref = (url: URL): string | null => {
  try {
    const target = readCommand(url);
    if (target?.id !== "mail.draft.calendar") return null;
    const input = MailDraftCalendarInputSchema.parse(target.input);
    return commandPath(
      mailDraftHref(input.mailboxId, input.draftId, target.options.returnTo ?? `/app/mail/${input.mailboxId}`),
      target.id,
      input,
      target.options,
    );
  } catch {
    return null;
  }
};
