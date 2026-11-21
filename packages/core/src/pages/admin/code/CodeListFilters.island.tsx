import { FilterChip, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { CodeAdminCodeStatus } from "../../../code/admin";
import { codeAreaHref } from "./area";
import { codeAdminMessages } from "./messages";

const STATUSES: CodeAdminCodeStatus[] = ["active", "waiting", "paused", "draft", "deleting"];

/** Status, app and search over all Code. Every choice is a URL, so reload and back keep the filtered list. */
export default function CodeListFilters(props: {
  status?: CodeAdminCodeStatus;
  app?: string;
  q?: string;
  apps: { id: string; name: string }[];
}) {
  const locale = useLocale();
  const t = () => codeAdminMessages.resolve([locale()]).t;
  const [q, setQ] = createSignal(props.q ?? "");
  const go = (next: { status?: CodeAdminCodeStatus; app?: string; q?: string }) =>
    window.location.assign(codeAreaHref({ sec: "code", status: props.status, app: props.app, q: props.q, ...next }));
  return (
    <div class="grid gap-2 px-2 pb-2">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          go({ q: q().trim() || undefined });
        }}
      >
        <TextInput type="search" aria-label={t().search} placeholder={t().search} value={q()} onValueChange={setQ} />
      </form>
      <div class="flex flex-wrap gap-2">
        <FilterChip
          label={t().status}
          icon="ti ti-circle-dot"
          showValue
          options={[{ options: STATUSES.map((value) => ({ value, label: t().statusLabel({ s: value }) })) }]}
          value={props.status ? [props.status] : []}
          onValueChange={(value) => go({ status: STATUSES.find((status) => status === value[0]) })}
        />
        <FilterChip
          label={t().app}
          icon="ti ti-apps"
          showValue
          options={[
            { options: [{ value: "person", label: t().personal }, ...props.apps.map((app) => ({ value: app.id, label: app.name }))] },
          ]}
          value={props.app ? [props.app] : []}
          onValueChange={(value) => go({ app: value[0] })}
        />
      </div>
    </div>
  );
}
