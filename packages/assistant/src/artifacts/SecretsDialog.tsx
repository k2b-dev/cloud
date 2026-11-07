import { Button, NoticeCard, prompts, SplitButton, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { revokeApprovalPreference } from "../chat-code/approval-preferences";
import { httpApprovalNotice } from "../chat-code/code-approval-message";
import { isWebsiteRead } from "../chat-code/http-contracts";
import { artifactMessages } from "../chat-code/messages";
import { createSecretsDialog } from "../chat-code/SecretsDialog";
import { artifactClient } from "./client";
import type { HttpApproval, HttpHost } from "./http-host";
export const openSecretsDialog = createSecretsDialog(artifactClient);
/** A request a remembered approval of this app let through: the full URL, and one click to make the next one ask. */
function websiteReceipt(request: HttpApproval, approvalId: string | null) {
  const t = artifactMessages.resolve([document.documentElement.lang || "en"]).t;
  const host = new URL(request.url).host;
  toast(`${request.method} ${request.url}`, {
    title: t.websiteAllowedForApp({ host }),
    iconClass: "ti ti-world-check",
    action: approvalId
      ? {
          label: t.websiteRevoke,
          onClick: () =>
            void revokeApprovalPreference(approvalId).then(
              () => toast.success(t.websiteRevoked({ host })),
              () => toast.error(t.websiteRevokeFailed),
            ),
        }
      : null,
  });
}

export const browserHttpHost: HttpHost = {
  secret: openSecretsDialog,
  // Only a Studio app the person manages can use a website approval; the server decides from the stored request.
  allowed: async (request, signal) => {
    const website = await artifactClient.httpWebsite(request.id, false, signal).catch(() => null);
    signal.throwIfAborted();
    if (!website?.allowed) return false;
    websiteReceipt(request, website.approvalId);
    return true;
  },
  approve: async (request, signal) => {
    const website = await artifactClient.httpWebsite(request.id, false, signal).catch(() => null);
    let approved = false;
    await prompts.dialog<void>(
      (close) => {
        const locale = useLocale(),
          t = () => artifactMessages.resolve([locale()]).t;
        const abort = () => close();
        signal.addEventListener("abort", abort, { once: true });
        onCleanup(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) close();
        // A click that was meant for the app underneath cannot approve: the button arms late.
        const [armed, setArmed] = createSignal(false);
        const [remembering, setRemembering] = createSignal(false);
        const [failed, setFailed] = createSignal(false);
        const timer = setTimeout(() => setArmed(true), 500);
        onCleanup(() => clearTimeout(timer));
        const allowForApp = async () => {
          if (remembering()) return;
          setRemembering(true);
          setFailed(false);
          try {
            await artifactClient.httpWebsite(request.id, true, signal);
            approved = true;
            close();
          } catch {
            setFailed(true);
          } finally {
            setRemembering(false);
          }
        };
        return (
          <div class="flex flex-col gap-3">
            <NoticeCard
              tone={isWebsiteRead(request) ? "info" : "warning"}
              title={request.resourceTitle ?? t().httpRequest}
              detail={httpApprovalNotice(request, locale())}
            />
            <p class="break-all">
              <strong>{request.method}</strong> {request.url}
            </p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(request.headers, null, 2)}</pre>
            <Show when={request.bodyBytes}>
              <p>{request.bodyBytes} bytes</p>
              <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all">{request.bodyPreview}</pre>
              <Show when={request.bodyTruncated}>
                <p>{t().httpTruncated}</p>
              </Show>
            </Show>
            <Show when={failed()}>
              <p class="text-sm text-red-700 dark:text-red-300" role="alert">
                {t().REQUEST_FAILED}
              </p>
            </Show>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => close()}>
                {t().stop}
              </Button>
              <Show
                when={website?.offer}
                fallback={
                  <Button
                    disabled={!armed()}
                    onClick={() => {
                      approved = true;
                      close();
                    }}
                  >
                    {t().httpApprove}
                  </Button>
                }
              >
                <SplitButton
                  disabled={!armed()}
                  loading={remembering()}
                  menuLabel={t().httpMoreOptions}
                  menuPosition="bottom-right"
                  items={[{ label: t().allowWebsiteForApp, icon: "ti ti-world-check", action: () => void allowForApp() }]}
                  onClick={() => {
                    approved = true;
                    close();
                  }}
                >
                  {t().httpApprove}
                </SplitButton>
              </Show>
            </div>
          </div>
        );
      },
      { title: request.method + " · " + new URL(request.url).host, size: "medium" },
    );
    return approved;
  },
};
