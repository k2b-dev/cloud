import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CopyButton, IconButton, DataTable, type DataTableColumn, Placeholder, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { formatDateTime as formatDate } from "@k2b/cloud/shared";
import type { MetricsToken } from "../service";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  tokens: MetricsToken[];
  timeZone: string;
};

type CreateResponse =
  | {
      token: string;
      credential: MetricsToken;
    }
  | { message: string };

const errorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const data = (await response.json()) as { message?: string };
    return data.message ?? fallback;
  } catch {
    return fallback;
  }
};

const TokenDialog = (props: { token: string }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  return (
    <div class="flex flex-col gap-3">
      <p class="text-xs text-dimmed">{t.storeTokenNow}</p>
      <div class="rounded-md bg-zinc-100 p-3 dark:bg-zinc-800">
        <code class="block break-all text-[11px] text-primary">{props.token}</code>
      </div>
      <div class="flex justify-end">
        <CopyButton text={props.token} label={t.copyToken} variant="primary" size="sm" />
      </div>
    </div>
  );
};

export default function MetricsTokens(props: Props) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const createMutation = mutations.create<{ token: string; credential: MetricsToken }, { name: string; expiresAt: string | null }>({
    mutation: async (input) => {
      const response = await fetch("/api/gateway/metrics/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await response.json()) as CreateResponse;
      if (!response.ok || !("token" in data)) throw new Error("message" in data ? data.message : t.createMetricsTokenFailed);
      return data;
    },
    onSuccess: async (data) => {
      await prompts.dialog(() => <TokenDialog token={data.token} />, {
        title: t.metricsTokenCreated,
        icon: "ti ti-key",
      });
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const revokeMutation = mutations.create<void, MetricsToken>({
    mutation: async (token) => {
      const response = await fetch(`/api/gateway/metrics/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorMessage(response, t.revokeMetricsTokenFailed));
    },
    onSuccess: () => {
      toast.success(t.metricsTokenRevoked);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const createToken = async () => {
    const result = await prompts.form({
      title: t.createMetricsToken,
      icon: "ti ti-key",
      confirmText: t.create,
      fields: {
        name: {
          type: "text" as const,
          label: t.tokenName,
          description: t.tokenNameDescription,
          default: t.defaultMetricsTokenName,
          required: true,
        },
        expires_at: {
          type: "datetime" as const,
          label: t.expiry,
          description: t.expiryDescription,
        },
      },
    });
    if (!result) return;
    await createMutation.mutate({
      name: String(result.name ?? "").trim(),
      expiresAt: String(result.expires_at ?? "").trim() || null,
    });
  };

  const revokeToken = async (token: MetricsToken) => {
    const confirmed = await prompts.confirm(t.revokeTokenConfirm({ name: token.name }), {
      title: t.revokeMetricsToken,
      icon: "ti ti-key-off",
      confirmText: t.revoke,
      variant: "danger",
    });
    if (!confirmed) return;
    await revokeMutation.mutate(token);
  };

  const columns: DataTableColumn<MetricsToken>[] = [
    { id: "name", header: t.name, value: "name", cellClass: "font-medium text-primary" },
    { id: "prefix", header: t.prefix, value: "tokenPrefix", cellClass: "font-mono text-[11px] text-secondary" },
    { id: "scope", header: t.scopeLabel },
    { id: "expires", header: t.expires, cellClass: "whitespace-nowrap text-dimmed" },
    { id: "lastUsed", header: t.lastUsed, cellClass: "whitespace-nowrap text-dimmed" },
    { id: "action", header: t.action, align: "right" },
  ];

  return (
    <DataTable.Panel>
      <DataTable.Header title={t.bearerTokens} subtitle={t.bearerTokensDescription} size="sm">
        <Button type="button" size="sm" onClick={createToken} disabled={createMutation.loading()}>
          <i class={createMutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"} aria-hidden="true" />
          {t.newToken}
        </Button>
      </DataTable.Header>
      {props.tokens.length > 0 ? (
        <DataTable
          rows={props.tokens}
          columns={columns}
          getRowId={(token) => token.id}
          density="compact"
          surface="plain"
          renderCell={({ row: token, col, value, render }) => {
            if (col.id === "scope")
              return (
                <span class="tag bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">{token.scopes.join(", ") || "-"}</span>
              );
            if (col.id === "expires") return formatDate(token.expiresAt, { locale: locale(), timeZone: props.timeZone });
            if (col.id === "lastUsed") return formatDate(token.lastUsedAt, { locale: locale(), timeZone: props.timeZone });
            if (col.id === "action")
              return (
                <Tooltip.Anchor content={t.revokeMetricsToken}>
                  <IconButton
                    type="button"
                    variant="danger"
                    size="sm"
                    label={t.revokeNamedToken({ name: token.name })}
                    onClick={() => revokeToken(token)}
                    disabled={revokeMutation.loading()}
                  >
                    <i class={revokeMutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-key-off"} aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              );
            return render(value);
          }}
        />
      ) : (
        <Placeholder icon="ti ti-key" description={<>{t.noMetricsTokens}</>} />
      )}
    </DataTable.Panel>
  );
}
