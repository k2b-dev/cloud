import { ok, type Result, type ServiceError } from "@k2b/stdlib";
import { z } from "zod";
import type { MailRequestContext } from "../service";
import { withOneAccessRead } from "../service/access";
import { getAutomationLogItem, listAutomationLog } from "../service/automation-log";
import { readRetiredRuleRuns, retiredRunQuerySchema } from "../service/retired-rule-runs";
import type { MailCodeHistoryData } from "./MailCodeHistory";

/**
 * The history step of the mailbox's Code page as its address asks for it: one day of the retired rules' log (`day`,
 * `before`), the entry it opens (`entry`), and the earlier runs (`runAfter`, `run` with its snapshot). Bounded: one page
 * of the log and 50 runs.
 */
export const loadMailCodeHistory = async (
  request: MailRequestContext,
  mailboxId: string,
  url: URL,
  codeHref: string,
): Promise<Result<MailCodeHistoryData, ServiceError>> => {
  // the log, the entry and the runs check the same mailbox access: read it once for the whole step
  const context = withOneAccessRead(request);
  const entry = z.uuid().safeParse(url.searchParams.get("entry")).data ?? null;
  // A link to one entry (`?entry=`) without a day opens the day of that entry.
  const named = entry && !url.searchParams.get("day") ? await getAutomationLogItem(context, mailboxId, entry) : null;
  const day = url.searchParams.get("day") ?? (named?.ok ? named.data.at.slice(0, 10) : undefined);
  const before = url.searchParams.get("before") ?? undefined;
  const runsInput = retiredRunQuerySchema.safeParse({
    after: url.searchParams.get("runAfter") ?? undefined,
    run: url.searchParams.get("run") ?? undefined,
  });
  const runsQuery = runsInput.success ? runsInput.data : {};
  // the list of runs stays whole; the run the address opens is read with its snapshot beside it
  const [log, runs, opened] = await Promise.all([
    listAutomationLog(context, mailboxId, { ...(day ? { day } : {}), ...(before ? { before } : {}) }),
    readRetiredRuleRuns(context, mailboxId, { ...(runsQuery.after ? { after: runsQuery.after } : {}) }),
    runsQuery.run ? readRetiredRuleRuns(context, mailboxId, { run: runsQuery.run }) : null,
  ]);
  if (!log.ok) return log;
  const run = opened?.ok ? (opened.data.items[0] ?? null) : null;
  return ok({
    codeHref,
    day: log.data.day,
    items: log.data.items,
    nextCursor: log.data.nextCursor,
    entry: entry && log.data.items.some((item) => item.id === entry) ? entry : null,
    runs: runs.ok ? runs.data : null,
    run,
  });
};
