import { AppWorkspace, ButtonLink, Placeholder, StatusBadge } from "@k2b/ui";
import type { HealthApp, HealthWebhook } from "../../frontend/health-webhook-queries";
import {
  type Attention,
  areaText,
  OBSERVABILITY_SECTION_HREF,
  ObservabilityArea,
  SaveStatusFoot,
  SaveStatusHead,
} from "../_components/ObservabilityArea";
import AddWebhookButton from "./AddWebhookButton.island";
import WebhookDetail from "./WebhookDetail.island";

const ALERTS_PATH = OBSERVABILITY_SECTION_HREF.alerts;
const webhookHref = (id: string) => `${ALERTS_PATH}?webhook=${encodeURIComponent(id)}`;

export type AlertsViewProps = {
  c: Parameters<typeof ObservabilityArea>[0]["c"];
  locale: string;
  timeZone: string;
  attention: Attention;
  rows: HealthWebhook[];
  apps: HealthApp[];
  /** The list could not be read. */
  loadError: string | null;
  selectedId: string | null;
};

/** Alerts as a list beside the first column, and the open alert in the detail column. */
export function AlertsView(props: AlertsViewProps) {
  const { c, locale, timeZone, attention, rows, apps, selectedId } = props;
  const t = areaText(locale);
  const webhooks = { error: props.loadError };
  const selected = selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null;
  const active = rows.filter((row) => row.enabled).length;
  return (
    <ObservabilityArea c={c} locale={locale} section="alerts" attention={attention} level={selectedId ? "detail" : "section"}>
      <AppWorkspace.MainPane
        id="section"
        label={t.alerts}
        description={webhooks.error ? undefined : rows.length === 0 ? undefined : t.webhooksCount({ count: rows.length, active })}
        href={ALERTS_PATH}
        defaultSize={330}
        minSize={300}
        maxSize={420}
        actions={rows.length > 0 ? <AddWebhookButton apps={apps} /> : undefined}
      >
        {webhooks.error ? (
          <Placeholder
            state="error"
            icon="ti ti-cloud-off"
            title={t.loadFailed}
            description={t.loadFailedKeep}
            action={
              <ButtonLink href={selectedId ? webhookHref(selectedId) : ALERTS_PATH} variant="secondary" size="sm">
                {t.retry}
              </ButtonLink>
            }
          />
        ) : rows.length === 0 ? (
          <Placeholder
            icon="ti ti-webhook"
            title={t.noWebhooks}
            description={t.noWebhooksDetail}
            action={<AddWebhookButton apps={apps} variant="button" />}
          />
        ) : (
          <AppWorkspace.SidebarSection>
            {rows.map((row) => (
              <AppWorkspace.SidebarItem
                href={webhookHref(row.id)}
                navigation="document"
                active={row.id === selectedId}
                description={row.lastError ? row.lastError : row.url}
                meta={
                  <StatusBadge
                    variant="dot"
                    tone={!row.enabled ? "neutral" : row.lastError ? "error" : row.lastStatus === "warn" ? "warning" : "ok"}
                    label=""
                  />
                }
              >
                {row.name}
              </AppWorkspace.SidebarItem>
            ))}
          </AppWorkspace.SidebarSection>
        )}
      </AppWorkspace.MainPane>
      {selectedId ? (
        <AppWorkspace.MainPane
          id="detail"
          label={selected?.name ?? t.alerts}
          description={selected ? (selected.scopeKind === "all" ? t.webhookSub : t.webhookSubScoped) : undefined}
          actions={selected ? <SaveStatusHead /> : undefined}
        >
          {selected ? (
            <>
              <WebhookDetail webhook={selected} apps={apps} timeZone={timeZone} />
              <SaveStatusFoot />
            </>
          ) : webhooks.error ? null : (
            <Placeholder
              title={t.webhookGone}
              description={t.webhookGoneDetail}
              action={
                <ButtonLink href={ALERTS_PATH} variant="secondary" size="sm">
                  {t.alerts}
                </ButtonLink>
              }
            />
          )}
        </AppWorkspace.MainPane>
      ) : null}
    </ObservabilityArea>
  );
}
