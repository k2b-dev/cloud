import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { NoticeCard, Paper } from "@k2b/ui";
import type { JSX } from "solid-js";
import { ssr } from "../config";
import type { PublicShare } from "../contracts";
import { FilesError, filesService } from "../service";
import { shareAccessCookie } from "../share-access-cookie";
import { browserMessages } from "./browser-messages";
import PublicInbox from "./PublicInbox.island";
import PublicShareList from "./PublicShare.island";
import PublicShareUnlock from "./PublicShareUnlock.island";
import { sharePasswordMessages } from "./share-password-messages";

const load = async (token: string, kind: "download" | "inbox", access?: string): Promise<PublicShare | null | "locked"> => {
  try {
    return await filesService.publicShare(token, kind, {}, access);
  } catch (error) {
    if (error instanceof FilesError && error.code === "share_password_required") return "locked";
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
                  {props.share.expiresAt
                    ? t.publicAvailableUntil(
                        new Date(props.share.expiresAt).toLocaleString(props.locale, { dateStyle: "long", timeStyle: "short" }),
                      )
                    : t.noExpiry}
                </p>
              </div>
            </header>
            {props.share.note ? <p class="whitespace-pre-wrap text-sm">{props.share.note}</p> : null}
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

const publicPage = (kind: "download" | "inbox") =>
  ssr<AuthContext>(async (c) => {
    const token = c.req.param("token") ?? "";
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const share = await load(token, kind, shareAccessCookie(c));
    const locale = getLocale(c);
    const t = sharePasswordMessages.resolve([locale]).t;
    if (!share) c.status(404);
    return () => (
      <MinimalLayout c={c}>
        {share === "locked" ? (
          <main class="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-10">
            <Paper class="flex flex-col gap-4 p-6">
              <h1 class="text-lg font-semibold">{t.unlockTitle}</h1>
              <p class="text-sm text-dimmed">{t.unlockHint}</p>
              <PublicShareUnlock token={token} kind={kind} />
            </Paper>
          </main>
        ) : (
          <Card locale={locale} share={share}>
            {share ? (
              kind === "inbox" ? (
                <PublicInbox token={token} share={share} />
              ) : (
                <PublicShareList token={token} share={share} />
              )
            ) : null}
          </Card>
        )}
      </MinimalLayout>
    );
  });
export const publicSharePage = publicPage("download");
export const publicInboxPage = publicPage("inbox");
