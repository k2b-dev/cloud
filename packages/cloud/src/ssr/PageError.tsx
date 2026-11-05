import { ButtonLink, NotFoundState, Placeholder } from "@k2b/ui";
import type { Context } from "hono";
import type { PageErrorOptions, PageErrorStatus } from "../_internal/page-responses";
import { PWA_SCOPE } from "../contracts/pwa";
import { getLocale } from "../server/locale";
import { resolveAppPresentation } from "../shared/app-presentation";
import Layout from "./Layout";
import MinimalLayout from "./MinimalLayout";
import PwaLayout from "./PwaLayout";
import { pageErrorMessages } from "./page-error-messages";
import { pwaMessages } from "./pwa-messages";
import { getRuntimeContext } from "./runtime";

/**
 * The part a page of the mobile app belongs to, by its owner, in the reader's language. Read from the whole registry:
 * the display view leaves out apps with declared access until it is preloaded, and the owner names only itself here.
 */
const pwaPartName = (c: Context): string | undefined => {
  const owner = c.get("page").pwaOwner;
  const app = owner ? getRuntimeContext(c).apps.find((candidate) => candidate.id === owner && candidate.pwa) : undefined;
  return app ? resolveAppPresentation(app, getLocale(c)).name : undefined;
};

export const renderPageError = (c: Context, status: PageErrorStatus, options: PageErrorOptions) => {
  const { t } = pageErrorMessages.resolve([getLocale(c)]);
  // In the mobile app a part that refuses names itself, so the person knows what to ask for.
  const part = options.layout === "pwa" && status === 403 ? pwaPartName(c) : undefined;
  const partText = part ? pwaMessages.resolve([getLocale(c)]).t : undefined;
  const title =
    options.title ??
    (part && partText ? partText.partForbidden({ name: part }) : status === 403 ? t.forbidden : status === 404 ? t.notFound : t.failed);
  const description =
    options.description ??
    (part && partText
      ? partText.partForbiddenDescription({ name: part })
      : status === 403
        ? t.forbiddenDescription
        : status === 404
          ? t.notFoundDescription
          : t.failedDescription);
  const action = options.action ?? { label: t.home, href: "/" };
  c.get("page").title = title;

  if (options.layout === "pwa") {
    const pwa = pwaMessages.resolve([getLocale(c)]).t;
    return () => (
      <PwaLayout c={c} title={title}>
        <Placeholder
          state={status >= 500 ? "error" : "empty"}
          icon={status === 403 ? "ti ti-lock" : status === 404 ? "ti ti-compass-off" : undefined}
          title={title}
          description={description}
          action={
            <ButtonLink href={options.action?.href ?? PWA_SCOPE} variant="secondary">
              {options.action?.label ?? pwa.errorAction}
            </ButtonLink>
          }
        />
      </PwaLayout>
    );
  }

  return () =>
    options.layout === "minimal" ? (
      <MinimalLayout c={c}>
        <main class="flex-1 bg-[var(--ui-canvas)] p-[var(--ui-space-shell)]">
          <NotFoundState code={String(status)} title={title} description={description} action={action} />
        </main>
      </MinimalLayout>
    ) : (
      <Layout c={c} title={title}>
        <NotFoundState code={String(status)} title={title} description={description} action={action} />
      </Layout>
    );
};
