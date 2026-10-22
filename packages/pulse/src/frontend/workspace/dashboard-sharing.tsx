import { Button, Checkbox, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, prompts, TextInput } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import type { Dashboard } from "../../dashboard-contracts";
import { usePulseMessages } from "../use-messages";
import { DashboardClientError, dashboardClient } from "./dashboard-client";

const PublicationOperationSchema = z.object({
  kind: z.enum(["publish", "revoke"]),
  key: z.uuid(),
  revision: z.number().int().positive(),
  columns: z.record(z.string(), z.array(z.string())),
});

export const createDashboardSharing = (dashboard: Dashboard) => {
  const t = usePulseMessages();
  const [revision, setRevision] = createSignal(dashboard.revision);
  const [published, setPublished] = createSignal(dashboard.published);
  const [href, setHref] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<"conflict" | "unknown" | "denied" | null>(null);
  const [operation, setOperation] = createSignal<z.infer<typeof PublicationOperationSchema> | null>(null);
  const storageKey = `pulse:dashboard-publication:${dashboard.baseId}:${dashboard.id}`;
  const remember = (operation: z.infer<typeof PublicationOperationSchema> | null) => {
    setOperation(operation);
    try {
      if (operation) sessionStorage.setItem(storageKey, JSON.stringify(operation));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* In-memory retry remains available when session storage is disabled. */
    }
  };
  onMount(() => {
    try {
      const restored = PublicationOperationSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"));
      if (restored.success) {
        setOperation(restored.data);
        setFailure("unknown");
      }
    } catch {
      /* An unavailable or invalid local receipt never authorizes a write. */
    }
  });
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const run = async (kind: "publish" | "revoke") => {
    if (pending() || failure() === "conflict" || failure() === "denied") return;
    let op = operation();
    if (!op) {
      const confirmed = await prompts.confirm(kind === "publish" ? t().dashboardConfirmPublish : t().dashboardConfirmRevoke, {
        title: dashboard.name,
        confirmText: kind === "publish" ? t().dashboardPublish : t().dashboardRevoke,
        variant: kind === "publish" ? "primary" : "danger",
        signal: lifetime.signal,
      });
      if (!confirmed || lifetime.signal.aborted) return;
      op = {
        kind,
        key: crypto.randomUUID(),
        revision: revision(),
        columns: Object.fromEntries(dashboard.definition.panels.map((panel) => [panel.id, panel.columns])),
      };
      remember(op);
    }
    setPending(true);
    setFailure(null);
    try {
      const target = { baseId: dashboard.baseId, dashboardId: dashboard.id };
      if (op.kind === "publish") {
        const response = await dashboardClient.publish(target, op.revision, op.columns, op.key, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (response.revision < dashboard.revision) {
          remember(null);
          setFailure("conflict");
          return;
        }
        setHref(response.href);
        setRevision(response.revision);
        setPublished(true);
      } else {
        const response = await dashboardClient.revoke(target, op.revision, op.key, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (response.revision < dashboard.revision) {
          remember(null);
          setFailure("conflict");
          return;
        }
        setHref(null);
        setRevision(response.revision);
        setPublished(false);
      }
      remember(null);
    } catch (error) {
      if (error instanceof DashboardClientError && [401, 403, 404, 409].includes(error.status)) remember(null);
      if (!lifetime.signal.aborted)
        setFailure(
          error instanceof DashboardClientError && error.status === 409
            ? "conflict"
            : error instanceof DashboardClientError && [401, 403, 404].includes(error.status)
              ? "denied"
              : "unknown",
        );
    } finally {
      if (!lifetime.signal.aborted) setPending(false);
    }
  };
  const open = () =>
    dialogCore.open<void>(
      (close, context) => {
        const [reviewed, setReviewed] = createSignal<string[]>([]);
        const [confirmed, setConfirmed] = createSignal(false);
        const columns = dashboard.definition.panels.flatMap((panel) =>
          panel.columns.map((column) => ({ key: JSON.stringify([panel.id, column]), column, panel })),
        );
        context.setDismissHandler(() => {
          if (!pending()) close();
        });
        return (
          <PanelDialog>
            <PanelDialog.Header
              title={t().dashboardShare}
              subtitle={dashboard.name}
              close={() => {
                if (!pending()) close();
              }}
              closeDisabled={pending()}
            />
            <PanelDialog.Body>
              <p class="text-sm text-secondary">{t().dashboardPublishDetail}</p>
              <div class="my-4 flex flex-col gap-4">
                <For each={dashboard.definition.panels}>
                  {(panel) => (
                    <fieldset class="flex flex-col gap-2">
                      <legend class="mb-2 font-semibold">{panel.title}</legend>
                      <For each={columns.filter((item) => item.panel.id === panel.id)}>
                        {(item) => (
                          <Checkbox
                            label={item.column}
                            value={reviewed().includes(item.key)}
                            disabled={pending() || !!operation()}
                            onValueChange={(checked) =>
                              setReviewed((old) => (checked ? [...old, item.key] : old.filter((key) => key !== item.key)))
                            }
                          />
                        )}
                      </For>
                    </fieldset>
                  )}
                </For>
              </div>
              <Checkbox
                label={t().dashboardReviewColumns}
                value={confirmed()}
                onValueChange={setConfirmed}
                disabled={pending() || !!operation()}
              />
              <Show when={href()}>
                {(link) => (
                  <div class="mt-4">
                    <TextInput label={t().dashboardPublished} value={new URL(link(), window.location.origin).href} readOnly />
                  </div>
                )}
              </Show>
              <Show when={failure()}>
                <div class="mt-4">
                  <NoticeCard
                    role="alert"
                    tone="danger"
                    title={
                      failure() === "conflict"
                        ? t().dashboardConflict
                        : failure() === "denied"
                          ? t().dashboardDenied
                          : t().dashboardPublishFailure
                    }
                  >
                    <Show when={failure() !== "unknown"}>
                      <Button variant="secondary" onClick={() => window.location.reload()}>
                        {t().dashboardReload}
                      </Button>
                    </Show>
                  </NoticeCard>
                </div>
              </Show>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Show when={published() && !operation()}>
                <Button variant="danger" disabled={pending()} onClick={() => void run("revoke")}>
                  {t().dashboardRevoke}
                </Button>
              </Show>
              <Button variant="secondary" disabled={pending()} onClick={() => close()}>
                {t().close}
              </Button>
              <Show
                when={operation()}
                fallback={
                  <Button
                    disabled={pending() || !columns.length || reviewed().length !== columns.length || !confirmed() || !!failure()}
                    onClick={() => void run("publish")}
                  >
                    {t().dashboardPublish}
                  </Button>
                }
              >
                <Button
                  disabled={pending() || failure() === "conflict" || failure() === "denied"}
                  onClick={() => void run(operation()!.kind)}
                >
                  {pending() ? t().dashboardLoading : t().retry}
                </Button>
              </Show>
            </PanelDialog.Footer>
          </PanelDialog>
        );
      },
      { ...panelDialogOptions, signal: lifetime.signal },
    );
  return { open, failure, pending, published };
};
