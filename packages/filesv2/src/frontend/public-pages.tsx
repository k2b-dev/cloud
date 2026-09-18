import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { NoticeCard, Paper } from "@k2b/ui";
import type { JSX } from "solid-js";
import { ssr } from "../config";
import type { PublicShare } from "../contracts";
import { FilesError, filesService } from "../service";
import { browserMessages } from "./browser-messages";
import PublicInbox from "./PublicInbox.island";
import PublicShareList from "./PublicShare.island";

const load = async (token: string, kind: "download" | "inbox"): Promise<PublicShare | null> => {
  try {
    return await filesService.publicShare(token, kind);
  } catch (error) {
    if (error instanceof FilesError && error.status === 404) return null;
    throw error;
  }
};

function Card(props: { locale: string; share: PublicShare | null; children?: JSX.Element }) {
  const t = browserMessages.resolve([props.locale]).t;
  return (
    <main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10">
      <Paper class="flex flex-col gap-4 p-6">
        {props.share ? (
          <>
            <header class="flex items-start gap-3">
              <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--k2b-surface-muted)] text-xl text-[var(--k2b-action)]">
                <i class={props.share.kind === "inbox" ? "ti ti-inbox" : "ti ti-world-share"} aria-hidden="true" />
              </span>
              <div class="min-w-0">
                <h1 class="break-words text-lg font-semibold text-primary">{props.share.title}</h1>
                <p class="text-sm text-dimmed">
                  {t.publicAvailableUntil(new Date(props.share.expiresAt).toLocaleString(props.locale, { dateStyle: "long", timeStyle: "short" }))}
                </p>
              </div>
            </header>
            {props.children}
          </>
        ) : (
          <NoticeCard tone="warning" title={t.publicLinkUnavailable} detail={t.publicLinkUnavailableDescription} />
        )}
      </Paper>
      <p class="text-center text-xs text-dimmed">{t.sharedThrough}</p>
    </main>
  );
}

export const publicSharePage = ssr<AuthContext>(async (c) => {
  const token = c.req.param("token") ?? "";
  const share = await load(token, "download");
  const locale = getLocale(c);
  if (!share) c.status(404);
  return () => (
    <MinimalLayout c={c}>
      <Card locale={locale} share={share}>
        {share ? <PublicShareList token={token} share={share} /> : null}
      </Card>
    </MinimalLayout>
  );
});

export const publicInboxPage = ssr<AuthContext>(async (c) => {
  const token = c.req.param("token") ?? "";
  const share = await load(token, "inbox");
  const locale = getLocale(c);
  if (!share) c.status(404);
  return () => (
    <MinimalLayout c={c}>
      <Card locale={locale} share={share}>
        {share ? <PublicInbox token={token} /> : null}
      </Card>
    </MinimalLayout>
  );
});
