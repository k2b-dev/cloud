import { qr } from "@k2b/stdlib/qr";
import { Button, CopyButton, prompts, toast } from "@k2b/ui";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { ApiError, api, shareUrl } from "../lib/api";
import type { NoteRecord } from "../lib/model";
import { preferences } from "../prefs";
import { app, t } from "../state";
import { CLOUD_URL, Icon, WithCloud } from "../ui/common";

type Step = "terms" | "uploading" | "error" | "links";

const failureText = (error: unknown) => {
  const code = error instanceof ApiError ? error.code : "unavailable";
  if (code === "rate_limited") return t().shareRateLimited;
  if (code === "storage_full") return t().sharePaused;
  if (code === "too_large") return t().shareTooLarge;
  return t().shareFailedBody;
};

/** Uploads the note and its files, then marks the record as shared. Teilen lädt nur hoch, es wandelt nichts um. */
async function share(record: NoteRecord) {
  const store = app.store();
  if (!store) throw new ApiError("unavailable", 0);
  const state = await store.encodeState(record.id);
  const links = await api.createPad(state, record.meta.title);
  await store.update(record.id, { share: { kind: "own", readId: links.readId, editId: links.editId, sharedAt: Date.now() } });
  const stored = await store.listFiles(record.id);
  const failed = (
    await Promise.allSettled(
      stored.map((file) => api.uploadFile(links.editId, new File([file.blob], file.name, { type: file.blob.type }), file.key)),
    )
  ).filter((result) => result.status === "rejected");
  if (failed.length > 0) toast.error(t().uploadFailed);
  return links;
}

export async function stopSharing(record: NoteRecord) {
  const store = app.store();
  if (!store || record.share?.kind !== "own") return false;
  try {
    await api.deletePad(record.share.editId);
    await store.update(record.id, { share: null });
    return true;
  } catch {
    toast.error(t().stopSharingFailed, { action: { label: t().retry, onClick: () => void stopSharing(record) } });
    return false;
  }
}

function LinkBox(props: { id: string }) {
  const url = () => shareUrl(props.id);
  const parts = () => {
    const parsed = new URL(url());
    return { host: parsed.host, path: parsed.pathname };
  };
  return (
    <div class="n-linkbox">
      <code>
        <span class="n-host">{parts().host}</span>
        {parts().path}
      </code>
      <CopyButton variant="secondary" size="sm" text={url()} label={t().copy} copiedLabel={t().copied} />
    </div>
  );
}

function QrCode(props: { value: string }) {
  return <span class="n-qr-code" role="img" aria-label={t().qrLabel} innerHTML={qr.toSvg(props.value, { correctionLevel: "M" })} />;
}

function ShareBody(props: { record: () => NoteRecord | undefined; close: () => void }) {
  const initial = props.record()?.share?.kind === "own" ? "links" : "terms";
  const [step, setStep] = createSignal<Step>(initial);
  const [terms, setTerms] = createSignal(false);
  const [privacy, setPrivacy] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const firstShare = !preferences.firstShareSeen();
  const [stopping, setStopping] = createSignal(false);
  // Known before the first try: a full site says so here instead of after an upload that cannot succeed.
  const [paused] = createResource(
    () => step() === "terms",
    () => api.sharingPaused().catch(() => false),
  );

  const create = async () => {
    const record = props.record();
    if (!record) return;
    setStep("uploading");
    try {
      await share(record);
      setStep("links");
      if (firstShare) preferences.markFirstShareSeen();
    } catch (error) {
      setFailure(failureText(error));
      setStep("error");
    }
  };

  const own = () => {
    const share = props.record()?.share;
    return share?.kind === "own" ? share : undefined;
  };

  return (
    <div class="n-dialog">
      <Switch>
        <Match when={step() === "terms" || step() === "uploading"}>
          <h2>{t().shareTitle}</h2>
          <p class="n-lead">{t().shareLead}</p>
          <Show
            when={paused()}
            fallback={
              <div class="n-lockline">
                <Icon name="ti-link" />
                <div>{t().shareLinksSafe}</div>
              </div>
            }
          >
            <div class="n-lockline" data-tone="danger" role="status">
              <Icon name="ti-player-pause" />
              <div>{t().sharePaused}</div>
            </div>
          </Show>
          <label class="n-check">
            <input type="checkbox" checked={terms()} onChange={(event) => setTerms(event.currentTarget.checked)} />
            <span>
              {t().shareAgreeTermsBefore}
              <a href="/nutzungsbedingungen" target="_blank" rel="noopener">
                {t().terms}
              </a>
              {t().shareAgreeTermsAfter}
            </span>
          </label>
          <label class="n-check">
            <input type="checkbox" checked={privacy()} onChange={(event) => setPrivacy(event.currentTarget.checked)} />
            <span>
              {t().shareAgreePrivacyBefore}
              <a href="/datenschutz" target="_blank" rel="noopener">
                {t().privacyNotice}
              </a>
              {t().shareAgreePrivacyAfter}
            </span>
          </label>
          <p class="n-fine">{t().shareFine}</p>
          <div class="n-dialog-acts">
            <Button variant="ghost" onClick={() => props.close()}>
              {t().cancel}
            </Button>
            <Button
              variant="primary"
              disabled={!terms() || !privacy() || !app.online() || paused() === true}
              loading={step() === "uploading"}
              loadingLabel={t().creatingLinks}
              onClick={() => void create()}
            >
              <Icon name="ti-link" />
              {t().createLinks}
            </Button>
          </div>
        </Match>
        <Match when={step() === "error"}>
          <h2>{t().shareTitle}</h2>
          <div class="n-lockline" data-tone="danger" role="alert">
            <Icon name="ti-alert-circle" />
            <div>
              <b>{t().shareFailedTitle}</b> {failure()}
            </div>
          </div>
          <div class="n-dialog-acts">
            <Button variant="ghost" onClick={() => props.close()}>
              {t().later}
            </Button>
            <Button variant="primary" onClick={() => void create()}>
              <Icon name="ti-refresh" />
              {t().retry}
            </Button>
          </div>
        </Match>
        <Match when={step() === "links" && own()}>
          {(links) => (
            <>
              <h2>{t().sharedTitle}</h2>
              <p class="n-lead">{t().sharedLead}</p>
              <div class="n-linkrow">
                <div class="n-linkrow-lab">
                  <Icon name="ti-eye" />
                  {t().linkRead}
                </div>
                <LinkBox id={links().readId} />
              </div>
              <div class="n-linkrow">
                <div class="n-linkrow-lab">
                  <Icon name="ti-pencil" />
                  {t().linkEdit} <small>{t().linkEditHint}</small>
                </div>
                <LinkBox id={links().editId} />
              </div>
              <div class="n-qr">
                <QrCode value={shareUrl(links().editId)} />
                <div>
                  <b>{t().qrTitle}</b>
                  <span>{t().qrBody}</span>
                </div>
              </div>
              <Show when={firstShare}>
                <a class="n-more" href={CLOUD_URL} target="_blank" rel="noopener">
                  <img src="/cloud-logo.svg" alt="" />
                  <span>
                    <WithCloud text={t().cloudPitch} />
                  </span>
                </a>
              </Show>
              <div class="n-dialog-acts">
                <Button
                  class="n-left"
                  variant="ghost"
                  style={{ color: "var(--danger)" }}
                  loading={stopping()}
                  disabled={!app.online()}
                  onClick={async () => {
                    const record = props.record();
                    if (!record) return;
                    setStopping(true);
                    const stopped = await stopSharing(record);
                    setStopping(false);
                    if (stopped) props.close();
                  }}
                >
                  {t().stopSharing}
                </Button>
                <Button variant="primary" onClick={() => props.close()}>
                  {t().done}
                </Button>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}

export function openShare(noteId: string) {
  const record = () => app.records().find((entry) => entry.id === noteId);
  void prompts.dialog<void>((close) => <ShareBody record={record} close={() => close()} />, { header: false, history: true });
}
