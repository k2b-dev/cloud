import { Button, ButtonLink, prompts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { CodePageReady } from "./data";
import { codePageMessages } from "./messages";

/** Database storage and export controls shared by Code pages and Core administration. */
export function CodeDatabaseStatus(props: { codeId: string; database: NonNullable<CodePageReady["code"]["database"]> }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  const mb = (bytes: number) =>
    new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bytes / 1048576);
  return (
    <span class="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
      <span>
        <i class="ti ti-database" aria-hidden="true" />{" "}
        {props.database.bytes === null
          ? t().databaseUnavailable
          : t().databaseUsage({ used: mb(props.database.bytes), limit: mb(props.database.limit) })}
      </span>
      <Show when={props.database.owner}>
        {(owner) => <span>{t().databaseOwner({ used: mb(owner().reserved), limit: mb(owner().limit) })}</span>}
      </Show>
      <Show when={props.database.unused?.deleteAt}>
        {(date) => (
          <span class="basis-full text-(--k2b-text-muted)">
            {t().databaseDeleteAt({
              date: new Intl.DateTimeFormat(locale(), { dateStyle: "long", timeZone: "UTC" }).format(new Date(date())),
            })}
          </span>
        )}
      </Show>
      <span class="inline-flex flex-wrap items-start gap-2" classList={{ "basis-full": Boolean(props.database.unused) }}>
        <Show when={props.database.canExport && props.database.state !== "unused"}>
          <ButtonLink
            size="sm"
            variant="secondary"
            href={`/api/code/authoring/database/${props.codeId}/export`}
            target="_blank"
            rel="noopener"
          >
            <i class="ti ti-download" aria-hidden="true" /> {t().databaseExport}
          </ButtonLink>
        </Show>
        <Show when={props.database.unused?.canDelete}>
          <CodeDatabaseDelete codeId={props.codeId} unused={props.database.unused!} />
        </Show>
      </span>
    </span>
  );
}

/** The confirmation carries the exact incarnation and unused period shown by SSR. */
export function CodeDatabaseDelete(props: { codeId: string; unused: { namespace: string; since: string } }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  const [state, setState] = createSignal<"idle" | "busy" | "done" | "failed">("idle");
  const remove = async () => {
    if (state() !== "idle") return;
    if (
      !(await prompts.confirm(t().databaseDeleteConfirm, {
        title: t().databaseDelete,
        confirmText: t().databaseDelete,
        cancelText: t().databaseCancel,
        variant: "danger",
      }))
    )
      return;
    setState("busy");
    try {
      const response = await fetch("/api/code/authoring/database/delete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeId: props.codeId, namespace: props.unused.namespace, since: props.unused.since }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("delete_refused");
      setState("done");
    } catch {
      setState("failed");
    }
  };
  return (
    <span class="inline-grid w-32 gap-1">
      <Button
        size="sm"
        variant="secondary"
        loading={state() === "busy"}
        disabled={state() === "busy"}
        onClick={() => (state() === "done" || state() === "failed" ? window.location.reload() : void remove())}
      >
        {state() === "done" || state() === "failed" ? t().databaseReload : t().databaseDelete}
      </Button>
      <span role="status" class="h-10 text-xs text-(--k2b-text-muted)" title={state() === "failed" ? t().databaseDeleteFailed : undefined}>
        {state() === "failed" ? t().databaseDeleteFailedShort : state() === "done" ? t().databaseDeleting : ""}
      </span>
    </span>
  );
}
