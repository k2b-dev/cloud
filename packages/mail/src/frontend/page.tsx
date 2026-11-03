import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Layout, requestPath } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import type { MailRequestContext } from "../service";
import { mailboxPreferences } from "../service";
import { requestContactDirectory } from "../service/contact-directory";
import { localizeMailError } from "../service/error-messages";
import { mailWorkspaceCookie, readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import MailLanding from "./MailLanding.island";
import { readMailLandingLink } from "./mail-landing";
import { loadMailLanding } from "./mail-sidebar-data";
import { mailPageMessages } from "./pages-messages";

const log = logger("mail:landing");

/** Mail opens a mailbox directly; this page renders only when there is none to open, or the read failed. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return c.redirect("/");
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const link = readMailLandingLink((name) => c.req.query(name));
  if ("href" in link) return c.redirect(link.href);
  const workspacePreferences = readMailWorkspacePreferences(c.req.header("cookie"));
  // Pins and hidden mailboxes used to live in this cookie. Move this browser's lists to the person once, for
  // mailboxes they can still read, and drop them from the cookie, before they decide which mailbox opens. A failed
  // move keeps the cookie for the next visit and still opens a mailbox.
  if (workspacePreferences.pinnedMailboxIds.length > 0 || workspacePreferences.hiddenMailboxIds.length > 0) {
    try {
      await mailboxPreferences.importBrowserMailboxPreferences(context, workspacePreferences);
      c.header("Set-Cookie", mailWorkspaceCookie({ ...workspacePreferences, pinnedMailboxIds: [], hiddenMailboxIds: [] }), {
        append: true,
      });
    } catch (error) {
      log.warn("Mail could not move this browser's mailbox lists", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const landing = await loadMailLanding(context, workspacePreferences.lastMailboxId);
  if (landing.ok && landing.data) return c.redirect(`/app/mail/${landing.data}${link.view ? `?view=${link.view}` : ""}`);
  const directory = await requestContactDirectory(c);
  return () => (
    <Layout
      c={c}
      printHint={t.printHint}
      workspaceSidebarCollapsible={false}
      title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbMail }]}
    >
      <MailLanding
        error={landing.ok ? null : localizeMailError(landing.error, locale).message}
        retryHref={requestPath(c)}
        currentUserEmail={user.mail}
        contactDirectory={directory}
      />
    </Layout>
  );
});
