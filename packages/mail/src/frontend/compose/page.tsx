import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { type MailRequestContext, mailboxes } from "../../service";
import { requestContactDirectory } from "../../service/contact-directory";
import MailComposeIntentPage from "../_components/MailComposeIntentPage.island";
import { mailPageMessages } from "../pages-messages";
import { projectSsrMailboxList } from "../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const result = await mailboxes.listMailboxes(context, 200);
  const internalWritableMailboxes = result.ok
    ? result.data
        // New mail needs mailbox-wide write access; a writer of assigned conversations only replies in them.
        .filter((mailbox) => mailbox.accessScope === "mailbox" && (mailbox.permission === "write" || mailbox.permission === "admin"))
        .map((mailbox) => ({
          id: mailbox.id,
          name: mailbox.name,
          description: mailbox.description,
          canManage: mailbox.permission === "admin",
        }))
    : [];
  const writableMailboxes = await projectSsrMailboxList(internalWritableMailboxes);
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  const requestedMailboxId = c.req.query("mailbox");
  const initialMailboxId = writableMailboxes.some((mailbox) => mailbox.id === requestedMailboxId)
    ? requestedMailboxId!
    : writableMailboxes.length === 1
      ? writableMailboxes[0]!.id
      : "";

  const directory = await requestContactDirectory(c);
  return () => (
    <Layout
      c={c}
      printHint={t.printHint}
      fullPage
      focusMode
      title={[{ title: t.breadcrumbMail, href: "/app/mail" }, { title: t.newMessage }]}
    >
      <MailComposeIntentPage
        mailboxes={writableMailboxes}
        initialMailboxId={initialMailboxId}
        autoStart={!c.req.query("command") && c.req.query("autostart") === "1" && Boolean(initialMailboxId) && !c.req.query("mailto")}
        mailto={c.req.query("mailto") ?? null}
        returnHref={c.req.query("return") ?? null}
        contactDirectory={directory}
        currentUserId={user?.id}
        currentUserEmail={user?.mail ?? null}
      />
    </Layout>
  );
});
