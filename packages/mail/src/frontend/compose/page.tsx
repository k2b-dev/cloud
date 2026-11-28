import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { ResourceShortIdSchema } from "../../contracts";
import type { MailRequestContext } from "../../service";
import MailComposeIntentPage from "../_components/MailComposeIntentPage.island";
import { mailComposeDialogHref } from "../_components/mail-compose-route";
import { readMailWorkspacePreferences } from "../_components/mail-workspace-preferences";
import { loadMailComposeIntent } from "../compose-intent-data";
import { loadMailLanding } from "../mail-sidebar-data";
import { readMailV2Pilot, showsMailV2 } from "../mail-v2-pilot";
import { mailPageMessages } from "../pages-messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  // The same pilot as the mailbox page: New message is a dialog over the asked mailbox, else over the one Mail opens.
  // With no mailbox at all, Mail's own page says so; there is no dialog over nothing.
  if (showsMailV2(readMailV2Pilot(c), user?.mail)) {
    const requested = ResourceShortIdSchema.safeParse(c.req.query("mailbox"));
    const landing = requested.success
      ? null
      : await loadMailLanding(context, readMailWorkspacePreferences(c.req.header("cookie")).lastMailboxId);
    const mailboxId = requested.success ? requested.data : landing?.ok ? landing.data : null;
    return c.redirect(mailboxId ? mailComposeDialogHref(mailboxId, new URL(c.req.url).searchParams) : "/app/mail");
  }
  const intent = await loadMailComposeIntent(c, context, user);
  return () => (
    <Layout
      c={c}
      printHint={t.printHint}
      fullPage
      focusMode
      title={[{ title: t.breadcrumbMail, href: "/app/mail" }, { title: t.newMessage }]}
    >
      <MailComposeIntentPage {...intent} />
    </Layout>
  );
});
