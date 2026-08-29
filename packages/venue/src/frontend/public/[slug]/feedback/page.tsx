import { coreSettings } from "@valentinkolb/cloud/services";
import { getLocale } from "@valentinkolb/cloud/server";
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
    return () => (
      <main class="flex min-h-screen items-center justify-center bg-zinc-100 p-4 text-zinc-950">
        <section class="w-full max-w-md text-center">
          <i class="ti ti-message-off mb-4 text-5xl text-zinc-400" />
          <h1 class="text-2xl font-semibold">{t.feedbackUnavailable}</h1>
          <p class="mt-2 text-sm text-zinc-600">{t.feedbackUnavailableDescription}</p>
        </section>
      </main>
    );
  }

  return () => (
    <main class="min-h-screen bg-zinc-100 text-zinc-950">
      <div class="mx-auto flex min-h-screen w-full max-w-xl flex-col bg-white px-5 py-6 shadow-sm sm:px-8 sm:py-8">
        <header class="flex items-center gap-3 pb-5">
          {status.venue.logoBase64 ? (
            <img src={status.venue.logoBase64} alt="" class="size-12 rounded-xl bg-white object-contain p-1 ring-1 ring-zinc-200" />
          ) : (
            <span
              class="flex size-12 items-center justify-center rounded-xl text-xl text-white"
              style={{ "background-color": status.venue.accentColor }}
            >
              <i class={status.venue.icon || "ti ti-building-carousel"} />
            </span>
          )}
          <div class="min-w-0">
            <p class="text-xs font-medium uppercase text-zinc-500">{t.anonymousFeedback}</p>
            <h1 class="truncate text-xl font-semibold">{status.venue.name}</h1>
          </div>
        </header>

        <section class="flex flex-1 flex-col justify-center py-8">
          <div class="mb-6">
            <h2 class="text-2xl font-semibold">{t.visitQuestion}</h2>
            <p class="mt-2 text-sm leading-relaxed text-zinc-600">{t.feedbackPrompt}</p>
          </div>
          <PublicFeedbackForm venueId={status.venue.id} accentColor={status.venue.accentColor} variant="page" />
        </section>

        <footer class="pt-4">
          <a href={publicUrl} class="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 no-underline hover:text-zinc-950">
            <i class="ti ti-arrow-left" />
            {t.viewVenue({ name: status.venue.name })}
          </a>
        </footer>
      </div>
    </main>
  );
});
