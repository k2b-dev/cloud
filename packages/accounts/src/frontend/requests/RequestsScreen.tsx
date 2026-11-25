import { Bar, Button, Chip, Dialog, Field, Inline, Input, Notice, Pane, StatusRow, Table, Tabs, Text, Workspace } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../AccountsNav";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import { useRequestMessages } from "./messages";
import { REQUEST_STATUSES, type RequestStatusView, requestHref, requestsHref } from "./requests-url";

export type RequestRow = {
  id: string;
  name: string;
  firstName: string;
  email: string;
  status: "pending" | "completed" | "denied";
  /** When it was requested, formatted by the server. */
  requested: string;
  comment: string | null;
};

export type RequestsScreenProps = {
  status: RequestStatusView;
  requests: RequestRow[];
  total: number;
  page: number;
  pages: number;
  /** Creating an account from a request needs FreeIPA, as before v2. */
  freeIpaEnabled: boolean;
  pendingRequests: number;
};

const statusTone = { pending: "warn", completed: "ok", denied: "bad" } as const;

/** Account requests on v2: the status views as tabs, one row per request, create and deny at the row's end. */
export default function RequestsScreen(props: RequestsScreenProps) {
  const t = useAccountsMessages();
  const r = useRequestMessages();
  const words = useListMessages();
  const { showChanges } = usePageSwap();
  const [denying, setDenying] = createSignal<RequestRow | null>(null);
  const statusLabel = (value: RequestStatusView) =>
    value === "all" ? t().all : value === "pending" ? t().pending : value === "completed" ? t().completed : t().denied;

  return (
    <Workspace
      sidebar={<AccountsNav active="requests" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            <Tabs
              label={t().requestStatus}
              items={REQUEST_STATUSES.map((value) => ({
                label: statusLabel(value),
                href: requestsHref(value),
                current: value === props.status,
              }))}
            />
          }
          end={
            <Button variant="primary" icon="user-plus" href="/app/accounts/users/new">
              {t().newUser}
            </Button>
          }
        />
      }
      primary={{ label: t().newUser, icon: "user-plus", href: "/app/accounts/users/new" }}
    >
      <Show when={denying()}>
        {(request) => (
          <DenyDialog
            request={request()}
            close={(denied) => {
              setDenying(null);
              if (denied) void showChanges();
            }}
          />
        )}
      </Show>
      <Pane
        label={t().requests}
        scrollKey="accounts-requests"
        status={<StatusRow lead={r().lead({ count: props.total, status: props.status })} />}
      >
        {/* k2b-ui gap: virtualized list (lane MW). Until it lands the page bounds the rows to 100 per page. */}
        <Table
          label={t().requests}
          rows={props.requests}
          rowKey={(request) => request.id}
          sticky
          // k2b-ui gap: a Table opens every row or none; only pending requests have a page to open (the new-user form
          // with the request). In the pending view every row opens it, so the phone keeps "create" and "deny" there.
          open={props.status === "pending" && props.freeIpaEnabled ? (request) => ({ href: requestHref(request.id) }) : undefined}
          empty={{ icon: "user-plus", text: props.status === "pending" ? r().emptyPending : t().noRequests }}
          // k2b-ui gap: on the phone an address without a break point runs a few signs past the edge of the second line.
          phone={(request) => ({
            lines: [request.name, `${request.email} · ${request.requested}`],
            marks: <Chip status={statusTone[request.status]}>{statusLabel(request.status)}</Chip>,
          })}
          columns={[
            { title: t().request, width: { min: 160, default: 200 }, cell: (request) => <Text weight="strong">{request.name}</Text> },
            { title: t().email, width: { min: 160, default: 240 }, cell: (request) => request.email, drop: true },
            {
              title: t().status,
              width: { min: 110, default: 120 },
              cell: (request) => <Chip status={statusTone[request.status]}>{statusLabel(request.status)}</Chip>,
            },
            { title: t().requested, width: { min: 100, default: 120 }, cell: (request) => request.requested, drop: true },
            { title: t().comment, width: { min: 140, default: 240 }, cell: (request) => request.comment || "–", drop: true },
            {
              title: t().actions,
              width: { min: 210, default: 220 },
              cell: (request) =>
                request.status === "pending" ? (
                  <Inline>
                    <Show when={props.freeIpaEnabled}>
                      <Button variant="text" icon="user-plus" href={requestHref(request.id)} title={r().createFor({ name: request.name })}>
                        {t().create}
                      </Button>
                    </Show>
                    <Button variant="text" icon="x" onClick={() => setDenying(request)} title={r().denyFor({ name: request.name })}>
                      {t().deny}
                    </Button>
                  </Inline>
                ) : (
                  "–"
                ),
              drop: true,
            },
          ]}
        />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{words().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={requestsHref(props.status, props.page - 1)} disabled={props.page <= 1}>
                  {words().previous}
                </Button>
                <Button href={requestsHref(props.status, props.page + 1)} disabled={props.page >= props.pages} forward>
                  {words().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}

/** Asks once more before a request is denied, with an optional reason the person receives by email. */
function DenyDialog(props: { request: RequestRow; close: (denied: boolean) => void }) {
  const t = useAccountsMessages();
  const r = useRequestMessages();
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const deny = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiClient["account-requests"][":id"].deny
        .$post({ param: { id: props.request.id }, json: { reason: reason().trim() || undefined } })
        .catch(() => null);
      if (!response?.ok) {
        // only a JSON body carries the service's own sentence; anything else gets the deed's fallback
        const body = response?.headers.get("content-type")?.includes("application/json")
          ? ((await response.json().catch(() => null)) as { message?: string } | null)
          : null;
        setError(body?.message ?? t().denyRequestFailed);
        return;
      }
      props.close(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().denyAccountRequest}
      open
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => props.close(false)} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="x" onClick={() => void deny()} busy={busy()}>
            {t().denyRequest}
          </Button>
        </>
      }
    >
      <Notice tone="warn">{t().denyConfirm({ name: props.request.firstName, email: props.request.email })}</Notice>
      <Field name="reason" label={t().reason} optional={r().optional} hint={t().denyReasonDescription}>
        <Input multiline value={reason()} onInput={setReason} placeholder={t().denyReasonPlaceholder} disabled={busy()} />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
