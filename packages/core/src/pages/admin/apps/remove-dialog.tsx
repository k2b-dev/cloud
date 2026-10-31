import { mutation } from "@k2b/stdlib/solid";
import { Button, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, toast } from "@k2b/ui";
import { onCleanup, Show } from "solid-js";
import { appsPageMessages } from "./page-messages";

/** Hides an app that is not running from the list; Core and every provider that reported it forget its entry. */
export const removeAppListing = async (appId: string, signal?: AbortSignal): Promise<"removed" | "running" | "failed"> => {
  const response = await fetch(`/api/admin/apps/${encodeURIComponent(appId)}/listing`, {
    method: "DELETE",
    credentials: "same-origin",
    signal,
  }).catch(() => null);
  if (response?.ok) return "removed";
  if (response?.status === 409) return "running";
  return "failed";
};

/**
 * Asks before the entry leaves the list. While it runs the dialog stays and can't be closed; a failure stays in the
 * dialog and keeps the app listed, a success closes it, says so, and returns to the list.
 */
export const openRemoveDialog = (app: { id: string; name: string }, locale: string) =>
  dialogCore.open<boolean>(
    (close, context) => {
      const t = appsPageMessages.resolve([locale]).t;
      const remove = mutation.create({
        mutation: async (_: void, { abortSignal }) => {
          const outcome = await removeAppListing(app.id, abortSignal);
          if (outcome === "running") throw new Error(t.removeRunning);
          if (outcome === "failed") throw new Error(t.removeFailed({ name: app.name }));
        },
        onSuccess: () => {
          toast.success(t.removed({ name: app.name }));
          close(true);
          const url = new URL(window.location.href);
          window.location.assign(url.searchParams.get("app") === app.id ? "/admin/apps" : `${url.pathname}${url.search}`);
        },
      });
      onCleanup(() => remove.abort());
      context.setDismissHandler(() => {
        if (!remove.loading()) close(false);
      });
      return (
        <PanelDialog>
          <div class="contents" data-remove-dialog={app.id}>
            <PanelDialog.Header
              title={t.removeTitle({ name: app.name })}
              icon="ti ti-trash"
              close={() => close(false)}
              closeDisabled={remove.loading()}
            />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <p>{t.removeText({ name: app.name })}</p>
                <Show when={remove.error()}>
                  {(error) => (
                    <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                      {error().message}
                    </NoticeCard>
                  )}
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="secondary" disabled={remove.loading()} onClick={() => close(false)}>
                {t.cancel}
              </Button>
              <Button variant="danger" loading={remove.loading()} onClick={() => void remove.mutate()}>
                {remove.loading() ? t.removeBusy : remove.error() ? t.retry : t.removeConfirm}
              </Button>
            </PanelDialog.Footer>
          </div>
        </PanelDialog>
      );
    },
    { ...panelDialogOptions, role: "alertdialog", ariaLabel: app.name },
  );
