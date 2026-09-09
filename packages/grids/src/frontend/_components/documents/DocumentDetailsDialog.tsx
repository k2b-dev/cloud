import { type DateContext, text } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  Dropdown,
  dialogCore,
  IconButton,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  StatusBadge,
  useLocale,
} from "@k2b/ui";
import { type Accessor, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { recordDisplayTitle } from "../records/record-display";
import { errorMessage } from "../utils/api-helpers";
import { openDocumentLinkDialog } from "./DocumentLinkDialog";
import { formatDocumentDateTime, formatDocumentRelativeTime } from "./document-workspace-utils";
import { documentMessages } from "./messages";
import type { PublicDocument, PublicDocumentLink, PublicDocumentLinkListResponse } from "./public-document-types";

type DocumentDetailsDialogArgs = {
  document: PublicDocument;
  templateName?: string;
  canWrite: boolean;
  dateConfig?: DateContext;
  onDownload: (document: PublicDocument) => void | Promise<void>;
  onGenerateAgain?: (document: PublicDocument) => void | Promise<void>;
};

export const openDocumentDetailsDialog = (args: DocumentDetailsDialogArgs) =>
  dialogCore.open<void>((close) => <DocumentDetailsDialog args={args} close={close} />, {
    ...panelDialogOptions,
    panelClassName: `${panelDialogOptions.panelClassName} grids-document-dialog`,
  });

export function DocumentDetailsDialog(props: { args: DocumentDetailsDialogArgs; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const document = () => props.args.document;
  const dateConfig = () => ({ ...props.args.dateConfig, locale: locale() });
  const sourceRecord = query.create({
    source: () => document().recordId,
    load: async (recordId, { abortSignal }) => {
      const tableId = document().tableId;
      const res = await apiClient.records[":tableId"][":recordId"].$get(
        { param: { tableId, recordId }, query: {} },
        { init: { signal: abortSignal } },
      );
      if (res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw new Error(t().sourceUnavailable);
      const fields = await apiClient.fields["by-table"][":tableId"].$get({ param: { tableId } }, { init: { signal: abortSignal } });
      if (fields.status === 403 || fields.status === 404) return null;
      if (!fields.ok) throw new Error(t().sourceUnavailable);
      return { record: await res.json(), fields: await fields.json() };
    },
  });
  const links = query.create({
    source: () => document().id,
    enabled: () => props.args.canWrite,
    load: async (documentId, { abortSignal }): Promise<PublicDocumentLink[]> => {
      const res = await apiClient.documents[":documentId"].links.$get({ param: { documentId } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await errorMessage(res, t().couldNotLoadDocumentLinks));
      return ((await res.json()) as PublicDocumentLinkListResponse).items;
    },
  });
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    const expiries = (links.data() ?? []).filter((link) => !link.revokedAt).map((link) => new Date(link.expiresAt).getTime());
    const next = Math.min(...expiries.filter((expiry) => expiry > now()));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, next - Date.now()), 2_147_483_647));
    onCleanup(() => clearTimeout(timer));
  });
  const linkSummary = () => {
    if (links.error()) return t().couldNotLoadLinks;
    if (!links.data() || links.refreshing()) return t().loadingLinks;
    const count = links.data()!.filter((link) => !link.revokedAt && new Date(link.expiresAt).getTime() > now()).length;
    return count === 0 ? t().noActiveLinks : t().activeLinkCount({ count, formatted: new Intl.NumberFormat(locale()).format(count) });
  };
  const download = mutations.create<void, void>({
    mutation: async () => {
      await props.args.onDownload(document());
    },
    onError: (error) => prompts.error(error.message),
  });
  const openTechnical = () =>
    dialogCore.open<void>((close) => <DocumentTechnicalDialog args={props.args} close={close} />, panelDialogOptions);
  const openLinks = () => {
    if (!props.args.canWrite) return;
    void links.refresh();
    return dialogCore.open<void>(
      (close) => <DocumentLinksDialog args={props.args} links={links} now={now} close={close} />,
      panelDialogOptions,
    );
  };
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.args.templateName ?? document().number}
        subtitle={`${props.args.templateName ? `${document().number} · ` : ""}${formatDocumentDateTime(document().createdAt, dateConfig())}`}
        close={props.close}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-6">
          <div class="flex items-center gap-3">
            <span class="grids-document-file-icon shrink-0 rounded-lg px-3 py-4 text-xs font-semibold text-dimmed" aria-hidden="true">
              PDF
            </span>
            <div class="min-w-0">
              <p class="break-words text-sm font-medium text-primary">{document().filename}</p>
              <p class="text-xs text-dimmed">
                PDF ·{" "}
                {text.pprintBytes(document().artifacts.find((artifact) => artifact.key === "pdf")?.sizeBytes ?? 0, { locale: locale() })}
              </p>
            </div>
          </div>
          <dl class="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt class="mb-1 text-xs text-dimmed">{t().sourceRecord}</dt>
              <dd>
                <Show when={sourceRecord.data() !== null} fallback={<span class="text-dimmed">{t().sourceUnavailable}</span>}>
                  <ButtonLink
                    variant="text"
                    class="grids-document-source-link"
                    size="sm"
                    navigation="document"
                    href={`/app/grids/${encodeURIComponent(document().baseId)}/table/${encodeURIComponent(document().tableId)}?record=${encodeURIComponent(document().recordId)}`}
                  >
                    {sourceRecord.data() ? recordDisplayTitle({ ...sourceRecord.data()!, dateConfig: dateConfig() }) : t().openSourceRecord}
                    <i class="ti ti-arrow-up-right" />
                  </ButtonLink>
                </Show>
              </dd>
            </div>
            <div>
              <dt class="mb-1 text-xs text-dimmed">{t().template}</dt>
              <dd>
                <ButtonLink
                  variant="text"
                  class="grids-document-source-link"
                  size="sm"
                  navigation="document"
                  href={`/app/grids/${encodeURIComponent(document().baseId)}/document/${encodeURIComponent(document().tableId)}/${encodeURIComponent(document().templateId)}`}
                >
                  {props.args.templateName ?? t().openTemplate}
                  <i class="ti ti-arrow-up-right" />
                </ButtonLink>
              </dd>
            </div>
          </dl>
          <p class="flex items-center gap-2 text-xs text-dimmed">
            <i class="ti ti-lock" aria-hidden="true" />
            {t().immutableSummary}
          </p>
          <Show when={document().validationStatus}>
            {(status) => (
              <div class="flex items-center gap-2 text-sm">
                <span>{t().validation}</span>
                <StatusBadge tone={status() === "valid" ? "ok" : "warning"} label={status() === "valid" ? t().valid : t().warning} />
              </div>
            )}
          </Show>
          <Show when={document().artifacts.some((artifact) => artifact.key !== "pdf")}>
            <div class="flex flex-col gap-3">
              <For each={document().artifacts.filter((artifact) => artifact.key !== "pdf")}>
                {(artifact) => (
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="min-w-0">
                      <p class="break-words text-sm">{artifact.filename}</p>
                      <p class="text-xs text-dimmed">
                        {artifact.mimeType} · {text.pprintBytes(artifact.sizeBytes, { locale: locale() })}
                      </p>
                    </div>
                    <ButtonLink
                      variant="secondary"
                      size="sm"
                      navigation="document"
                      href={`/api/grids/documents/${encodeURIComponent(document().id)}/artifacts/${encodeURIComponent(artifact.key)}`}
                    >
                      <i class="ti ti-download" />
                      {t().download}
                    </ButtonLink>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="flex flex-col gap-1">
            <Show when={props.args.canWrite}>
              <Button variant="ghost" class="grids-document-detail-row" onClick={openLinks}>
                <span class="min-w-0">{t().publicLinks}</span>
                <span class="ml-auto text-right text-xs font-normal text-dimmed" aria-live="polite">
                  {linkSummary()}
                </span>
                <i class="ti ti-chevron-right shrink-0 text-dimmed" aria-hidden="true" />
              </Button>
            </Show>
            <Button variant="ghost" class="grids-document-detail-row" onClick={openTechnical}>
              <span class="min-w-0">{t().technicalDetails}</span>
              <span class="ml-auto text-right text-xs font-normal text-dimmed">{t().idsAndChecksums}</span>
              <i class="ti ti-chevron-right shrink-0 text-dimmed" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div>
          <Show when={props.args.canWrite && props.args.onGenerateAgain}>
            <Dropdown.Root
              position="top-left"
              items={[
                {
                  icon: "ti ti-file-plus",
                  label: t().generateAgain,
                  description: t().generateAgainHint,
                  action: () => {
                    props.close();
                    void props.args.onGenerateAgain?.(document());
                  },
                },
              ]}
            >
              <Dropdown.Trigger variant="ghost" size="sm">
                {t().moreActions}
                <i class="ti ti-chevron-down" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </Show>
        </div>
        <Button variant="primary" loading={download.loading()} onClick={() => void download.mutate(undefined)}>
          <i class="ti ti-download" />
          {t().downloadPdf}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function DocumentTechnicalDialog(props: { args: DocumentDetailsDialogArgs; close: () => void }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const document = () => props.args.document;
  const rendererLabel = () => {
    const renderer = document().renderer;
    return renderer.kind === "html" ? "HTML" : `${renderer.id}@${renderer.version}`;
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().technicalDetails} subtitle={document().number} icon="ti ti-info-circle" close={props.close} />
      <PanelDialog.Body>
        <p class="text-sm text-dimmed">{t().immutableDocumentDetail}</p>
        <dl class="grid gap-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt class="text-dimmed">{t().documentId}</dt>
          <dd class="break-all">{document().id}</dd>
          <dt class="text-dimmed">{t().template}</dt>
          <dd class="break-all">{document().templateId}</dd>
          <dt class="text-dimmed">{t().sourceRecord}</dt>
          <dd class="break-all">{document().recordId}</dd>
          <dt class="text-dimmed">{t().createdBy}</dt>
          <dd class="break-all">{document().createdBy ?? t().system}</dd>
          <dt class="text-dimmed">{t().renderer}</dt>
          <dd class="break-all">{rendererLabel()}</dd>
        </dl>
        <For each={document().artifacts}>
          {(artifact) => (
            <div class="flex flex-col gap-1">
              <p class="break-words text-sm font-medium">{artifact.filename}</p>
              <p class="text-xs text-dimmed">
                {artifact.mimeType} · {text.pprintBytes(artifact.sizeBytes, { locale: locale() })}
              </p>
              <p class="break-all font-mono text-xs text-dimmed">SHA-256 {artifact.sha256}</p>
            </div>
          )}
        </For>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <Button variant="secondary" onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function DocumentLinksDialog(props: {
  args: DocumentDetailsDialogArgs;
  links: ReturnType<typeof query.create<string, PublicDocumentLink[]>>;
  now: Accessor<number>;
  close: () => void;
}) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const dateConfig = () => ({ ...props.args.dateConfig, locale: locale() });
  const linkStatus = (link: PublicDocumentLink): { label: string; tone: "ok" | "neutral"; active: boolean } => {
    if (link.revokedAt) return { label: t().revoked, tone: "neutral", active: false };
    if (new Date(link.expiresAt).getTime() <= props.now()) return { label: t().expired, tone: "neutral", active: false };
    return { label: t().active, tone: "ok", active: true };
  };
  const links = props.links;

  const revokeMut = mutations.create<PublicDocumentLink, PublicDocumentLink>({
    mutation: async (link) => {
      const res = await apiClient.documents.links[":linkId"].revoke.$post({ param: { linkId: link.id } });
      if (!res.ok) throw new Error(await errorMessage(res, t().couldNotRevokeDocumentLink));
      return res.json();
    },
    onSuccess: async () => {
      await links.refresh();
    },
    onError: (error) => prompts.error(error.message),
  });

  const createLink = () =>
    void openDocumentLinkDialog({
      document: props.args.document,
      onCreated: async () => {
        await links.refresh();
      },
    });

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().publicLinks} subtitle={props.args.document.number} icon="ti ti-link" close={props.close} />
      <PanelDialog.Body>
        <Show when={props.args.canWrite}>
          <section class="flex flex-col gap-2">
            <div class="flex flex-col items-start gap-4">
              <div>
                <p class="text-xs text-dimmed">{t().publicLinksDescription}</p>
              </div>
              <Button variant="secondary" size="sm" type="button" onClick={createLink}>
                <i class="ti ti-link-plus" />
                {t().newLink}
              </Button>
            </div>
            <div class="flex flex-col gap-1">
              <Show when={!links.loading()} fallback={<Placeholder state="loading" align="left" title={t().loadingLinks} />}>
                <Show
                  when={!links.error()}
                  fallback={
                    <div class="flex flex-col items-start gap-2 py-3 text-sm text-dimmed">
                      {t().couldNotLoadLinks}
                      <Button variant="secondary" onClick={() => void links.refresh()}>
                        {t().retryLinks}
                      </Button>
                    </div>
                  }
                >
                  <Show when={(links.data() ?? []).length > 0} fallback={<Placeholder align="left" description={t().noActiveLinks} />}>
                    <For each={links.data()}>
                      {(link) => {
                        const status = () => linkStatus(link);
                        return (
                          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md px-3 py-2">
                            <div class="min-w-0">
                              <div class="flex min-w-0 flex-wrap items-center gap-2">
                                <StatusBadge tone={status().tone} label={status().label} />
                                <span class="text-xs text-secondary">
                                  {t().expiresAt({ time: formatDocumentDateTime(link.expiresAt, dateConfig()) })}
                                </span>
                              </div>
                              <Show when={link.comment}>{(comment) => <p class="mt-1 truncate text-sm text-primary">{comment()}</p>}</Show>
                              <p class="mt-1 text-xs text-dimmed">
                                {t().linkActivity({
                                  created: formatDocumentRelativeTime(link.createdAt, dateConfig()),
                                  count: link.accessCount,
                                  formattedCount: new Intl.NumberFormat(locale()).format(link.accessCount),
                                  last: link.lastAccessedAt ? formatDocumentRelativeTime(link.lastAccessedAt, dateConfig()) : null,
                                })}
                              </p>
                            </div>
                            <Show when={status().active}>
                              <IconButton
                                variant="ghost"
                                size="sm"
                                class="shrink-0 text-dimmed hover:text-secondary"
                                label={t().revokeLink}
                                onClick={async () => {
                                  if (
                                    await prompts.confirm(t().revokeLinkConfirmation, {
                                      title: t().revokeLink,
                                      variant: "danger",
                                      confirmText: t().revokeLink,
                                    })
                                  )
                                    await revokeMut.mutate(link);
                                }}
                                disabled={revokeMut.loading()}
                              >
                                {revokeMut.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-link-off" />}
                              </IconButton>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </Show>
            </div>
          </section>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <Button variant="secondary" onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
