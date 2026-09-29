import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { accentTokens } from "../../../../accent";
import { ssr } from "../../../../config";
import { venueMessages } from "../../../../messages";
import { venueService } from "../../../../service";
import PublicFeedbackForm from "../../../_components/PublicFeedbackForm.island";
import { buildPublicVenueUrl, resolveVenuePublicOrigin } from "../../../public-runtime";

export default ssr(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex");
  const id = c.req.param("id");
  const internalStatus = id ? await venueService.publicStatus(id, new Date(), getLocale(c)) : null;
  const status = internalStatus ? await venueService.publicResources.projectPublicStatus(internalStatus) : null;
  const requestOrigin = new URL(c.req.raw.url).origin;
  const appUrl = await coreSettings.get<string>("app.url").catch(() => "");
  const publicUrl = id ? buildPublicVenueUrl(resolveVenuePublicOrigin(appUrl, requestOrigin), id) : "/app/venue";
  c.get("page").title = status ? t.pageTitleFeedback({ name: status.venue.name }) : t.feedbackUnavailable;

  if (!status || !status.venue.feedbackEnabled) {
    if (!status) c.status(404);
    c.header("Cache-Control", "private, no-store");
    return () => (
      <MinimalLayout c={c} preferences={false}>
        <main class="flex min-h-dvh items-center justify-center p-4 text-primary">
          <section class="w-full max-w-md text-center">
            <i class="ti ti-message-off mb-4 text-5xl text-dimmed" aria-hidden="true" />
            <h1 class="text-2xl font-semibold">{t.feedbackUnavailable}</h1>
            <p class="mt-2 text-sm text-secondary">{t.feedbackUnavailableDescription}</p>
          </section>
        </main>
      </MinimalLayout>
    );
  }

  // Like the public page, the form follows the visitor's Cloud theme.
  return () => (
    <MinimalLayout c={c} preferences={false}>
      <main class="min-h-dvh text-primary">
        <div class="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-5 py-6 sm:px-8 sm:py-8">
          <header class="flex items-center gap-3 pb-5">
            {status.venue.logoBase64 ? (
              <img
                src={status.venue.logoBase64}
                alt=""
                class="size-12 shrink-0 rounded-xl border border-zinc-200 bg-white object-contain p-1 dark:border-zinc-800"
              />
            ) : (
              <span
                class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[var(--venue-accent)] text-xl text-[var(--venue-on-accent)]"
                style={accentTokens(status.venue.accentColor)}
              >
                <i class={status.venue.icon || "ti ti-building-carousel"} aria-hidden="true" />
              </span>
            )}
            <div class="min-w-0">
              <p class="text-xs font-medium uppercase text-dimmed">{t.anonymousFeedback}</p>
              <h1 class="line-clamp-2 break-words text-xl font-semibold">{status.venue.name}</h1>
            </div>
          </header>

          <section class="flex flex-1 flex-col justify-center py-8">
            <div class="mb-6">
              <h2 class="text-2xl font-semibold">{t.visitQuestion}</h2>
              <p class="mt-2 text-sm leading-relaxed text-secondary">{t.feedbackPrompt}</p>
            </div>
            <PublicFeedbackForm venueId={status.venue.id} accentColor={status.venue.accentColor} variant="page" />
          </section>

          <footer class="pt-4">
            <a
              href={publicUrl}
              class="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-secondary no-underline hover:text-primary"
            >
              <i class="ti ti-arrow-left" aria-hidden="true" />
              {t.viewVenue({ name: status.venue.name })}
            </a>
          </footer>
        </div>
      </main>
    </MinimalLayout>
  );
});
