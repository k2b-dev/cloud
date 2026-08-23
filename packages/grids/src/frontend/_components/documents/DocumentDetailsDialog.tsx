import { type DateContext, text } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  StatusBadge,
} from "@k2b/ui";
import { createResource, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { openDocumentLinkDialog } from "./DocumentLinkDialog";
import { formatDocumentDateTime, formatDocumentRelativeTime } from "./document-workspace-utils";
import type { PublicDocument, PublicDocumentLink, PublicDocumentLinkListResponse } from "./public-document-types";

type DocumentDetailsDialogArgs = {
  document: PublicDocument;
  canWrite: boolean;
  dateConfig?: DateContext;
  onDownload: (run: PublicDocument) => void | Promise<void>;
  onGenerateAgain?: (run: PublicDocument) => void | Promise<void>;
};

const linkStatus = (link: PublicDocumentLink): { label: string; tone: "ok" | "neutral"; active: boolean } => {
  if (link.revokedAt) return { label: "Revoked", tone: "neutral", active: false };
  if (new Date(link.expiresAt).getTime() <= Date.now()) return { label: "Expired", tone: "neutral", active: false };
  return { label: "Active", tone: "ok", active: true };
};

export const openDocumentDetailsDialog = (args: DocumentDetailsDialogArgs) =>
  dialogCore.open<void>((close) => <DocumentDetailsDialog args={args} close={close} />, panelDialogOptions);

function DocumentDetailsDialog(props: { args: DocumentDetailsDialogArgs; close: () => void }) {
  const [links, { refetch: refetchLinks }] = createResource(
    () => (props.args.canWrite ? props.args.document.id : null),
    async (documentId): Promise<PublicDocumentLink[]> => {
      if (!documentId) return [];
      const res = await apiClient.documents[":documentId"].links.$get({ param: { documentId } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not load document links"));
      return ((await res.json()) as PublicDocumentLinkListResponse).items;
    },
  );

  const revokeMut = mutations.create<PublicDocumentLink, PublicDocumentLink>({
    mutation: async (link) => {
      const res = await apiClient.documents.links[":linkId"].revoke.$post({ param: { linkId: link.id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not revoke document link"));
      return res.json();
    },
    onSuccess: async () => {
      await refetchLinks();
    },
    onError: (error) => prompts.error(error.message),
  });

  const createLink = () =>
    void openDocumentLinkDialog({
      document: props.args.document,
      onCreated: async () => {
        await refetchLinks();
      },
    });

  return (
    <PanelDialog>
      <PanelDialog.Header title="Document details" subtitle={props.args.document.filename} icon="ti ti-file-text" close={props.close} />
      <PanelDialog.Body>
        <section class="flex flex-col gap-2">
          <NoticeCard
            tone="info"
            title="Completed document"
            detail="The number, source snapshot, and stored artifacts are immutable. Generate again to create a new Document."
          />
          <dl class="grid gap-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt class="text-dimmed">Number</dt>
            <dd class="min-w-0 truncate font-mono text-xs text-secondary">{props.args.document.number}</dd>
            <dt class="text-dimmed">Created</dt>
            <dd class="text-secondary">{formatDocumentRelativeTime(props.args.document.createdAt, props.args.dateConfig)}</dd>
            <dt class="text-dimmed">Created by</dt>
            <dd class="min-w-0 truncate font-mono text-xs text-secondary">{props.args.document.createdBy ?? "System"}</dd>
            <dt class="text-dimmed">Renderer</dt>
            <dd class="min-w-0 truncate text-xs text-secondary">
              {props.args.document.renderer.kind === "html"
                ? "HTML"
                : `${props.args.document.renderer.id}@${props.args.document.renderer.version}`}
            </dd>
            <dt class="text-dimmed">Template</dt>
            <dd class="min-w-0 truncate font-mono text-xs text-secondary">{props.args.document.templateId}</dd>
            <dt class="text-dimmed">Source record</dt>
            <dd class="min-w-0 truncate font-mono text-xs text-secondary">{props.args.document.recordId}</dd>
            <Show when={props.args.document.validationStatus}>
              {(status) => (
                <>
                  <dt class="text-dimmed">Validation</dt>
                  <dd><StatusBadge tone={status() === "valid" ? "ok" : "warning"} label={status()} /></dd>
                </>
              )}
            </Show>
          </dl>
          <section class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-primary">Artifacts</h3>
            <For each={props.args.document.artifacts}>
              {(artifact) => (
                <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--ui-radius-control)] border border-subtle px-3 py-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-medium text-primary">{artifact.filename}</p>
                    <p class="text-xs text-dimmed">{artifact.mimeType} · {text.pprintBytes(artifact.sizeBytes)}</p>
                    <p class="mt-1 break-all font-mono text-[10px] text-dimmed">SHA-256 {artifact.sha256}</p>
                  </div>
                  <ButtonLink
                    variant="secondary"
                    size="sm"
                    navigation="document"
                    href={`/api/grids/documents/${encodeURIComponent(props.args.document.id)}/artifacts/${encodeURIComponent(artifact.key)}`}
                  >
                    <i class="ti ti-download" />
                    Download
                  </ButtonLink>
                </div>
              )}
            </For>
          </section>
        </section>
        <Show when={props.args.canWrite}>
          <section class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <div>
                <h3 class="text-sm font-semibold text-primary">Public links</h3>
                <p class="text-xs text-dimmed">Expiring download links for this stored document.</p>
              </div>
              <Button variant="secondary" size="sm" type="button" onClick={createLink}>
                <i class="ti ti-link-plus" />
                New link
              </Button>
            </div>
            <div class="flex flex-col gap-1">
              <Show when={!links.loading} fallback={<Placeholder state="loading" align="left" title="Loading links..." />}>
                <Show
                  when={!links.error}
                  fallback={<div class="p-3 text-sm text-red-600">{links.error?.message ?? "Could not load links."}</div>}
                >
                  <Show
                    when={(links() ?? []).length > 0}
                    fallback={<Placeholder align="left" description="No public links for this document." />}
                  >
                    <For each={links()}>
                      {(link) => {
                        const status = () => linkStatus(link);
                        return (
                          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md px-3 py-2">
                            <div class="min-w-0">
                              <div class="flex min-w-0 flex-wrap items-center gap-2">
                                <StatusBadge tone={status().tone} label={status().label} />
                                <span class="text-xs text-secondary">
                                  Expires {formatDocumentDateTime(link.expiresAt, props.args.dateConfig)}
                                </span>
                              </div>
                              <Show when={link.comment}>{(comment) => <p class="mt-1 truncate text-sm text-primary">{comment()}</p>}</Show>
                              <p class="mt-1 text-xs text-dimmed">
                                Created {formatDocumentRelativeTime(link.createdAt, props.args.dateConfig)}
                                {link.accessCount > 0 ? ` · ${link.accessCount} downloads` : ""}
                                {link.lastAccessedAt
                                  ? ` · last ${formatDocumentRelativeTime(link.lastAccessedAt, props.args.dateConfig)}`
                                  : ""}
                              </p>
                            </div>
                            <Show when={status().active}>
                              <IconButton
                                variant="ghost"
                                size="sm"
                                class="shrink-0 text-dimmed hover:text-secondary"
                                label="Revoke link"
                                onClick={() => void revokeMut.mutate(link)}
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
            <p class="text-xs text-dimmed">For security, the full URL is only shown when the link is created.</p>
          </section>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void props.args.onDownload(props.args.document)}
        >
          <i class="ti ti-download" />
          Download
        </Button>
        <div class="flex items-center justify-end gap-2">
          <Show when={props.args.canWrite && props.args.onGenerateAgain}>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => {
                props.close();
                void props.args.onGenerateAgain?.(props.args.document);
              }}
            >
              <i class="ti ti-file-plus" />
              Generate again
            </Button>
          </Show>
          <Button variant="secondary" size="sm" type="button" onClick={props.close}>
            Close
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
