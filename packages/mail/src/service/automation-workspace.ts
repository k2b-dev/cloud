import { ok, type Result } from "@k2b/stdlib";
import type { AutomationLogPage, AutomationLogQuery, Mailbox } from "../contracts";
import * as access from "./access";
import type { MailRequestContext } from "./auth";
import { listAutomationLog, MAIL_AUTOMATION_LOG_TIME_ZONE } from "./automation-log";
import * as mailboxes from "./mailboxes";

export type MailAutomationAccessData = { mailbox: Mailbox; permission: "read" | "write" | "admin" };

export type MailAutomationLogData = {
  mailbox: Mailbox & { timeZone: string };
  permission: "read" | "write" | "admin";
  log: AutomationLogPage;
};

export const loadMailAutomationLog = async (
  context: MailRequestContext,
  mailboxId: string,
  query: AutomationLogQuery = {},
): Promise<Result<MailAutomationLogData>> => {
  const permission = await access.requireMailboxAccess(context, mailboxId, "read");
  if (!permission.ok) return permission;
  const mailbox = await mailboxes.getMailbox(context, mailboxId);
  if (!mailbox.ok) return mailbox;
  const log = await listAutomationLog(context, mailboxId, query);
  if (!log.ok) return log;
  return ok({
    mailbox: { ...mailbox.data, timeZone: MAIL_AUTOMATION_LOG_TIME_ZONE },
    permission: permission.data.permission,
    log: log.data,
  });
};
