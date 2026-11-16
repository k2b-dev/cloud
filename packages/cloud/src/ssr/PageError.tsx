import { ButtonLink, NotFoundState, Placeholder } from "@k2b/ui";
import type { Context } from "hono";
import type { PageErrorOptions, PageErrorStatus } from "../_internal/page-responses";
import { PWA_SCOPE } from "../contracts/pwa";
import { type MaintenanceGameTexts, maintenanceGameMessages, offersMaintenanceGame } from "../maintenance-game";
import { getLocale } from "../server/locale";
import { resolveAppPresentation } from "../shared/app-presentation";
import Layout from "./Layout";
import MinimalLayout from "./MinimalLayout";
import PwaLayout from "./PwaLayout";
import { pageErrorMessages } from "./page-error-messages";
import { pwaMessages } from "./pwa-messages";
import { getRuntimeContext } from "./runtime";
import WaitingGame from "./WaitingGame.island";

/**
 * The part a page of the mobile app belongs to, by its owner, in the reader's language. Read from the whole registry:
 * the display view leaves out apps with declared access until it is preloaded, and the owner names only itself here.
 */
const pwaPartName = (c: Context): string | undefined => {
  const owner = c.get("page").pwaOwner;
  const app = owner ? getRuntimeContext(c).apps.find((candidate) => candidate.id === owner && candidate.pwa) : undefined;
  return app ? resolveAppPresentation(app, getLocale(c)).name : undefined;
};

/**
 * The generic „not found“ and server failure in the layout of the maintenance page: a symbol, the heading, one
 * sentence and the way home, with the waiting scene below. The scene's box is part of the first paint, so nothing
 * moves when the game code arrives. The symbol starts a round, but takes no focus: „Go to home page“ comes first.
 */
const WaitingErrorPage = (props: {
  status: number;
  title: string;
  description: string;
  action: { label: string; href: string };
  game: MaintenanceGameTexts;
}) => (
  <div class="cloud-error-page">
    <div class="cloud-error-page__copy" data-waiting-error-copy>
      <div class="cloud-error-page__fold">
        <div>
          <button type="button" class="cloud-error-page__tile" tabindex="-1" aria-label={props.game.start} data-waiting-game-start>
            {/* „404“ has its own glyph; a server failure shows its code in the same small digits. */}
            {props.status === 404 ? <i class="ti ti-error-404" aria-hidden="true" /> : <span aria-hidden="true">{props.status}</span>}
          </button>
        </div>
      </div>
      <h1>{props.title}</h1>
      <div class="cloud-error-page__fold">
        <div>
          <p>{props.description}</p>
        </div>
      </div>
      <div class="cloud-error-page__actions">
        <ButtonLink href={props.action.href}>{props.action.label}</ButtonLink>
      </div>
    </div>
    <WaitingGame t={props.game} anchor="[data-waiting-error-copy]" />
    <div class="cloud-error-page__road" />
  </div>
);

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
  // Only the generic „not found“ and server failure show the waiting game, below the way out.
  const offered = offersMaintenanceGame(status, { ...options, path: c.req.path });
  const page = () =>
    offered ? (
      <WaitingErrorPage
        status={status}
        title={title}
        description={description}
        action={action}
        game={maintenanceGameMessages.resolve([getLocale(c)]).t}
      />
    ) : (
      <NotFoundState code={String(status)} title={title} description={description} action={action} />
    );

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
        <main class="flex-1 bg-[var(--ui-canvas)] p-[var(--ui-space-shell)]">{page()}</main>
      </MinimalLayout>
    ) : (
      // Like the maintenance page, the shell names the Cloud above the heading instead of repeating it; the document
      // keeps the error as its title.
      <Layout c={c} title={offered ? undefined : title}>
        {page()}
      </Layout>
    );
};
