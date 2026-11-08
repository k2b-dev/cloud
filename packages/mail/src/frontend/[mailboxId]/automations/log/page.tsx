import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { Button, Format, TextInput } from "@k2b/ui";
import { For, Show } from "solid-js";
import { z } from "zod";
import { ssr } from "../../../../config";
import { getAutomationLogItem, listAutomationLog } from "../../../../service/automation-log";
import { getMailbox } from "../../../../service/mailboxes";
import { readRetiredRuleRuns, retiredRunQuerySchema } from "../../../../service/retired-rule-runs";
import { mailPageMessages } from "../../../pages-messages";
import { resolveSsrMailboxId } from "../../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const context = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const mailbox = await getMailbox(context, mailboxId);
  if (!mailbox.ok) return ssr.error(c, mailbox.error.status);
  const day = c.req.query("day");
  const before = c.req.query("before");
  const result = await listAutomationLog(context, mailboxId, { ...(day ? { day } : {}), ...(before ? { before } : {}) });
  if (!result.ok) return ssr.error(c, result.error.status);
  const entry = z.uuid().safeParse(c.req.query("entry")).data;
  const detail = entry ? await getAutomationLogItem(context, mailboxId, entry) : null;
  if (detail && !detail.ok) return ssr.error(c, detail.error.status);
  const runsInput = retiredRunQuerySchema.safeParse({ after: c.req.query("runAfter"), run: c.req.query("run") });
  if (!runsInput.success) return ssr.error(c, 400);
  const runs = await readRetiredRuleRuns(context, mailboxId, runsInput.data);
  if (runsInput.data.run && !runs.ok) return ssr.error(c, runs.error.status);
  const title = t.retiredRuleHistoryTitle;
  const base = `/app/mail/${mailboxShortId}/automations/log`;
  return () => (
    <Layout
      c={c}
      title={[{ title: t.breadcrumbMail, href: "/app/mail" }, { title: mailbox.data.name, href: `/app/mail/${mailboxShortId}` }, { title }]}
    >
      <main class="mx-auto max-w-4xl space-y-4 p-4" data-print-region>
        <h1 class="text-xl font-semibold">{title}</h1>
        <p class="text-secondary">{t.retiredRuleHistoryDescription}</p>
        <form method="get" class="flex gap-2">
          <label for="mail-rule-history-day">
            {t.retiredRuleHistoryDay}{" "}
            <TextInput
              id="mail-rule-history-day"
              type="text"
              placeholder={t.retiredRuleHistoryDatePlaceholder}
              name="day"
              value={result.data.day}
            />
          </label>
          <Button type="submit">{t.retiredRuleHistoryShow}</Button>
        </form>
        <For each={result.data.items}>
          {(item) => (
            <article class="rounded border border-default p-3">
              <a href={`${base}?day=${result.data.day}&entry=${item.id}`}>
                <Format.Date value={item.at} /> · {item.conversation.subject}
              </a>
              <pre class="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(item, null, 2)}</pre>
            </article>
          )}
        </For>
        <Show when={detail?.ok && detail.data}>
          {(item) => <pre class="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(item(), null, 2)}</pre>}
        </Show>
        <Show when={result.data.nextCursor}>
          {(cursor) => (
            <a href={`${base}?day=${result.data.day}&before=${encodeURIComponent(cursor())}`}>{t.retiredRuleHistoryOlderEntries}</a>
          )}
        </Show>
        <Show when={runs.ok && runs.data}>
          {(history) => (
            <section class="space-y-3">
              <h2 class="text-lg font-semibold">{t.retiredRuleHistoryEarlierRuns}</h2>
              <For each={history().items}>
                {(run) => (
                  <article class="rounded border border-default p-3">
                    <a href={`${base}?day=${result.data.day}&run=${run.id}`}>
                      <Format.Date value={run.createdAt} /> · {run.name} · {run.state}
                    </a>
                    <Show when={run.snapshot}>
                      <pre class="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(run.snapshot, null, 2)}</pre>
                    </Show>
                  </article>
                )}
              </For>
              <Show when={history().nextCursor}>
                {(cursor) => <a href={`${base}?day=${result.data.day}&runAfter=${cursor()}`}>{t.retiredRuleHistoryMoreRuns}</a>}
              </Show>
            </section>
          )}
        </Show>
      </main>
    </Layout>
  );
});
