import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { z } from "zod";
import { ssr } from "../../../../config";
import type { MailRequestContext } from "../../../../service";
import { getAutomationLogItem } from "../../../../service/automation-log";
import { loadMailAutomationLog } from "../../../../service/automation-workspace";
import { requestContactDirectory } from "../../../../service/contact-directory";
import MailAutomationLogPage from "../../../MailAutomationLogPage.island";
import { mailPageMessages } from "../../../pages-messages";
import { projectAutomationWorkspace, resolveSsrMailboxId } from "../../../ssr-public-boundary";

const FILTERS = ["all", "assignments", "uncertain", "skipped", "manual"] as const;
const readFilter = (value: string | undefined) => FILTERS.find((filter) => filter === value) ?? "all";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return ssr.error(c, 403);
  if (!mailboxShortId) return ssr.error(c, 404);
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  // The URL holds the filter and search, so reload and back show the same view the server rendered.
  const filter = readFilter(c.req.query("filter"));
  const q = c.req.query("q")?.trim().slice(0, 200) || undefined;
  // Only a well-formed entry ID reaches the service; anything else opens the log without a detail.
  const entry = z.string().uuid().safeParse(c.req.query("entry")).data;
  const [result, detail] = await Promise.all([
    loadMailAutomationLog(context, mailboxId, { filter, q }),
    entry ? getAutomationLogItem(context, mailboxId, entry) : null,
  ]);
  if (!result.ok) return ssr.error(c, result.error.status);
  const data = await projectAutomationWorkspace(result.data);
  const directory = await requestContactDirectory(c);
  return () => (
    <Layout
      c={c}
      printHint={t.printHint}
      fullPage
      workspaceSidebarCollapsible={false}
      title={[
        { title: t.breadcrumbStart, href: "/" },
        { title: t.breadcrumbMail, href: "/app/mail" },
        { title: data.mailbox.name, href: `/app/mail/${mailboxShortId}` },
        { title: t.breadcrumbAutomations, href: `/app/mail/${mailboxShortId}/automations` },
        { title: t.breadcrumbLog },
      ]}
    >
      <MailAutomationLogPage
        data={data}
        detail={detail?.ok ? detail.data : null}
        filter={filter}
        q={q ?? null}
        currentUserEmail={user.mail}
        contactDirectory={directory}
      />
    </Layout>
  );
});
