import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ButtonLink } from "@k2b/ui";
import { ssr } from "../config";
import { contactDirectoryMessages } from "../contact-directory-messages";
import { requestContactDirectoryConfig } from "../contact-directory-settings";
import { contactDirectory, type MailRequestContext } from "../service";
import MailAdminContactDirectory from "./_components/MailAdminContactDirectory.island";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = contactDirectoryMessages.resolve([locale]);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const view = await contactDirectory.loadContactDirectoryAdmin(context, requestContactDirectoryConfig(c), locale);
  if (!view.ok) return ssr.error(c, view.error.code === "FORBIDDEN" ? 403 : 500);

  return () => (
    <AdminLayout c={c} title={t.title}>
      <div class="app-rows" data-scroll-preserve="mail-admin-contact-directory">
        <div>
          <div class="flex items-center gap-2">
            <ButtonLink href="/admin/mail" variant="subtle" size="sm">
              <i class="ti ti-arrow-left" aria-hidden="true" /> {t.back}
            </ButtonLink>
            <h1 class="text-base font-semibold text-primary">{t.title}</h1>
          </div>
          <p class="mt-1 max-w-2xl text-xs text-dimmed">{t.description}</p>
        </div>
        <MailAdminContactDirectory apps={view.data.apps} config={view.data.config} issues={view.data.issues} />
      </div>
    </AdminLayout>
  );
});
