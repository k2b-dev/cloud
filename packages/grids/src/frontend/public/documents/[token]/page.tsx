import { ButtonLink, NoticeCard, Paper } from "@k2b/ui";
import { type AuthContext, getDateConfig } from "@valentinkolb/cloud/server";
import { type JSX, Show } from "solid-js";
import { ssr } from "../../../../config";
import { gridsService } from "../../../../service";

const remainingTime = (expiresAt: string, now = Date.now()): string => {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return minutes <= 1 ? "less than a minute" : `${minutes} minutes`;
  const hours = Math.ceil(remainingMs / 3_600_000);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.ceil(remainingMs / 86_400_000);
  return days === 1 ? "1 day" : `${days} days`;
};

export function PublicDocumentShare(props: {
  filename?: string;
  expiresAt?: string;
  expiresAtLabel?: string;
  downloadHref?: string;
}): JSX.Element {
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
            fallback={
              <NoticeCard
                tone="warning"
                icon="ti ti-link-off"
                title="Link no longer available"
                detail="This document link has expired or was revoked."
              />
            }
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
              title={`Link expires in ${remainingTime(props.expiresAt!)}`}
              detail={
                <span>
                  Available until <time datetime={props.expiresAt}>{props.expiresAtLabel}</time>.
                </span>
              }
            />

            <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
              <ButtonLink href={props.downloadHref} navigation="document" size="md" variant="primary" download="">
                <i class="ti ti-download" aria-hidden="true" />
                Download PDF
              </ButtonLink>
              <p class="text-xs text-dimmed">Shared securely through Grids</p>
            </div>
          </Show>
        </Paper>
      </main>
    </div>
  );
}

export default ssr<AuthContext>(async (c) => {
  const token = c.req.param("token") ?? "";
  const resolved = await gridsService.document.resolveDocumentLinkDownload(token);
  c.get("page").theme = "light";

  if (!resolved.ok) {
    c.status(404);
    c.get("page").title = "Link no longer available";
    return () => <PublicDocumentShare />;
  }

  const dateConfig = await getDateConfig(c);
  const expiresAt = resolved.data.link.expiresAt;
  const expiresAtLabel = new Intl.DateTimeFormat(dateConfig.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: dateConfig.timeZone,
  }).format(new Date(expiresAt));

  c.get("page").title = resolved.data.document.filename;
  c.get("page").description = "A PDF document shared through Grids.";

  return () => (
    <PublicDocumentShare
      filename={resolved.data.document.filename}
      expiresAt={expiresAt}
      expiresAtLabel={expiresAtLabel}
      downloadHref={`/share/grids/documents/${encodeURIComponent(token)}/download`}
    />
  );
});
