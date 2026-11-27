import { ok, type Result, type ServiceError } from "@k2b/stdlib";
import { z } from "zod";
import type { MailRequestContext } from "../service";
import { withOneAccessRead } from "../service/access";
import { getAutomationLogItem, listAutomationLog } from "../service/automation-log";
import { readRetiredRuleRuns, readRetiredRunSteps, retiredRunQuerySchema } from "../service/retired-rule-runs";
import type { MailCodeHistoryData } from "./MailCodeHistory";

const dayKey = z.iso.date();

/**
 * The history step of the mailbox's Code page as its address asks for it: one day of the retired rules' log (`day`,
 * `before`), the entry it opens (`entry`), and the earlier runs (`runAfter`, `run` with its steps). Bounded: one page
 * of the log, 50 runs and 50 steps of the opened run. A day that is not a date shows today with a field error; runs
 * that cannot be read show an error in their section, not an error page.
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
  const asked = url.searchParams.get("day");
  const dayInvalid = asked !== null && !dayKey.safeParse(asked).success;
  const askedDay = asked !== null && !dayInvalid ? asked : null;
  // A link to one entry (`?entry=`) without a day opens the day of that entry.
  const named = entry && asked === null ? await getAutomationLogItem(context, mailboxId, entry) : null;
  const day = askedDay ?? (named?.ok ? named.data.at.slice(0, 10) : undefined);
  const before = (!dayInvalid && url.searchParams.get("before")) || null;
  const runsInput = retiredRunQuerySchema.safeParse({
    after: url.searchParams.get("runAfter") ?? undefined,
    run: url.searchParams.get("run") ?? undefined,
  });
  const runsQuery = runsInput.success ? runsInput.data : {};
  const openRun = runsQuery.run ?? null;
  // the list of runs stays whole; the run the address opens is read with its steps beside it
  const [log, runs, opened] = await Promise.all([
    listAutomationLog(context, mailboxId, { ...(day ? { day } : {}), ...(before ? { before } : {}) }),
    readRetiredRuleRuns(context, mailboxId, { ...(runsQuery.after ? { after: runsQuery.after } : {}) }),
    openRun ? readRetiredRunSteps(context, mailboxId, openRun) : null,
  ]);
  if (!log.ok) return log;
  return ok({
    codeHref,
    day: log.data.day,
    dayInvalid,
    today: new Date().toISOString().slice(0, 10),
    before,
    items: log.data.items,
    nextCursor: log.data.nextCursor,
    entry: entry && log.data.items.some((item) => item.id === entry) ? entry : null,
    runAfter: runsQuery.after ?? null,
    runs: runs.ok
      ? {
          items: runs.data.items.map(({ id, createdAt, name, state }) => ({ id, createdAt, name, state })),
          nextCursor: runs.data.nextCursor,
        }
      : null,
    run: openRun && opened ? (opened.ok ? opened.data : { id: openRun, failed: true as const }) : null,
  });
};
