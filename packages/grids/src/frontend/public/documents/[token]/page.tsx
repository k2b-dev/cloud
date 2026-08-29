import { ButtonLink, LocaleProvider, NoticeCard, Paper, useLocale } from "@k2b/ui";
import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { type JSX, Show } from "solid-js";
import { ssr } from "../../../../config";
import { gridsService } from "../../../../service";
import { resolveGridsMessages } from "../../../messages";

const remainingTime = (expiresAt: string, locale: string, now = Date.now()): string => {
  const { t } = resolveGridsMessages(locale);
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return minutes <= 1 ? t.lessThanMinute : t.minutes({ count: minutes });
  const hours = Math.ceil(remainingMs / 3_600_000);
  if (hours < 48) return t.hours({ count: hours });
  const days = Math.ceil(remainingMs / 86_400_000);
  return t.days({ count: days });
};

export function PublicDocumentShare(props: {
  filename?: string;
  expiresAt?: string;
  expiresAtLabel?: string;
  downloadHref?: string;
}): JSX.Element {
  const locale = useLocale();
  const t = () => resolveGridsMessages(locale()).t;
  const available = () => Boolean(props.filename && props.expiresAt && props.expiresAtLabel && props.downloadHref);

  return (
    <div
      class="flex min-h-screen items-center justify-center px-4 py-8 text-primary sm:py-12"
      style={{ background: "linear-gradient(145deg, #e8f8ef 0%, #f7fbf8 48%, #ffffff 100%)" }}
    >
      <main class="w-full max-w-xl">
        <Paper as="article" elevated class="w-full p-6 sm:p-8">
          <Show
            when={available()}
            fallback={<NoticeCard tone="warning" icon="ti ti-link-off" title={t().linkUnavailable} detail={t().documentLinkUnavailable} />}
          >
            <div class="flex items-center gap-3">
              <span class="app-accent-text flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-selected)]">
                <i class="ti ti-file-type-pdf text-lg" aria-hidden="true" />
              </span>
              <div class="min-w-0 flex-1">
                <h1 class="break-words text-base font-semibold leading-snug sm:text-lg">{props.filename}</h1>
              </div>
            </div>

            <NoticeCard
              class="mt-6"
              tone="info"
              title={t().linkExpiresIn({ duration: remainingTime(props.expiresAt!, locale()) })}
              detail={<span>{t().availableUntil({ date: props.expiresAtLabel! })}</span>}
            />

            <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
              <ButtonLink href={props.downloadHref} navigation="document" size="md" variant="primary" download="">
                <i class="ti ti-download" aria-hidden="true" />
                {t().downloadPdf}
              </ButtonLink>
              <p class="text-xs text-dimmed">{t().sharedThroughGrids}</p>
            </div>
          </Show>
        </Paper>
      </main>
    </div>
  );
}

export default ssr<AuthContext>(async (c) => {
  const token = c.req.param("token") ?? "";
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const resolved = await gridsService.document.resolveDocumentLinkDownload(token);
  c.get("page").theme = "light";

  if (!resolved.ok) {
    c.status(404);
    c.get("page").title = t.linkUnavailable;
    return () => (
      <LocaleProvider locale={locale}>
        <PublicDocumentShare />
      </LocaleProvider>
    );
  }

  const dateConfig = await getDateConfig(c);
  const expiresAt = resolved.data.link.expiresAt;
  const expiresAtLabel = new Intl.DateTimeFormat(dateConfig.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: dateConfig.timeZone,
  }).format(new Date(expiresAt));

  c.get("page").title = resolved.data.document.filename;
  c.get("page").description = t.sharedPdfDescription;

  return () => (
    <LocaleProvider locale={locale}>
      <PublicDocumentShare
        filename={resolved.data.document.filename}
        expiresAt={expiresAt}
        expiresAtLabel={expiresAtLabel}
        downloadHref={`/share/grids/documents/${encodeURIComponent(token)}/download`}
      />
    </LocaleProvider>
  );
});
