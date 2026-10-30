import { Button, toast } from "@k2b/ui";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { ApiError, api } from "../lib/api";
import type { NoteRecord } from "../lib/model";
import { preferences } from "../prefs";
import { navigate } from "../router";
import { app, t } from "../state";
import { Icon, type IconName, Wordmark } from "../ui/common";

type Failure = "gone" | "not_found" | "blocked" | "unavailable";

const matches = (record: NoteRecord, linkId: string) => {
  const share = record.share;
  if (!share) return false;
  return share.kind === "own" ? share.readId === linkId || share.editId === linkId : share.linkId === linkId || share.readId === linkId;
};

/**
 * /p/:id — a link from someone else (or one's own). The note is copied into this browser once and
 * then opened like any other note; a link that no longer works explains why and offers the local copy.
 */
export function SharedLink(props: { linkId: string }) {
  const [attempt, setAttempt] = createSignal(0);
  const local = () => app.records().find((record) => matches(record, props.linkId));
  const [result] = createResource(
    () => (app.ready() ? { attempt: attempt(), linkId: props.linkId } : undefined),
    async ({ linkId }): Promise<Failure | null> => {
      const store = app.store();
      if (!store) return "unavailable";
      try {
        const info = await api.link(linkId);
        const existing = local();
        if (existing) {
          // An edit link opened after the read link turns the read-only copy into an editable one.
          const share = existing.share;
          if (share?.kind === "foreign" && share.role === "read" && info.role === "edit")
            await store.update(existing.id, { share: { ...share, role: "edit", linkId } });
          navigate(`/n/${existing.id}`, { replace: true });
          return null;
        }
        const id = await store.create("", {
          share: { kind: "foreign", role: info.role, linkId, readId: info.readId, addedAt: Date.now() },
        });
        if (info.snapshot) await store.applyUpdate(id, info.snapshot);
        if (!info.liveAvailable) toast(t().readersOnlyBody, { title: t().readersOnlyTitle, duration: 0 });
        navigate(`/n/${id}`, { replace: true });
        return null;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "unavailable";
        if (code === "gone" || code === "not_found" || code === "blocked") return code;
        const existing = local();
        // Offline with a copy here: open it, it syncs when the browser is back online.
        if (existing) {
          navigate(`/n/${existing.id}`, { replace: true });
          return null;
        }
        return "unavailable";
      }
    },
  );
  const failure = () => result();
  const date = (record: NoteRecord) => new Intl.DateTimeFormat(preferences.locale(), { dateStyle: "medium" }).format(record.updatedAt);
  const texts = (): { icon: IconName; title: string; body: string } => {
    const m = t();
    const current = failure();
    if (current === "gone") return { icon: "ti-file-off", title: m.goneTitle, body: m.goneBody };
    if (current === "blocked") return { icon: "ti-ban", title: m.blockedTitle, body: m.blockedBody };
    if (current === "not_found") return { icon: "ti-file-off", title: m.notFoundTitle, body: m.notFoundBody };
    return { icon: "ti-cloud-off", title: m.linkErrorTitle, body: m.linkErrorBody };
  };

  return (
    <div class="n-page">
      <header class="n-topbar">
        <Wordmark />
        <div class="n-spacer" />
      </header>
      <Switch fallback={<main class="n-notfound" aria-busy="true" />}>
        <Match when={failure()}>
          <main class="n-notfound">
            <div class="n-ring">
              <Icon name={texts().icon} />
            </div>
            <h1>{texts().title}</h1>
            <p>{texts().body}</p>
            <Show when={failure() !== "unavailable" ? local() : undefined}>
              {(copy) => (
                <div class="n-copy">
                  <Icon name="ti-device-desktop" />
                  <div>
                    {t().localCopy}
                    <small>{t().localCopyState({ title: copy().meta.title || t().untitled, date: date(copy()) })}</small>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      // The copy becomes an ordinary local note: the dead link is gone from it.
                      await app.store()?.update(copy().id, { share: null });
                      navigate(`/n/${copy().id}`, { replace: true });
                    }}
                  >
                    {t().openCopy}
                  </Button>
                </div>
              )}
            </Show>
            <div class="n-acts">
              <Show
                when={failure() === "unavailable"}
                fallback={
                  <Button variant="primary" onClick={() => void app.createNote()}>
                    <Icon name="ti-plus" />
                    {t().newNote}
                  </Button>
                }
              >
                <Button variant="primary" onClick={() => setAttempt(attempt() + 1)}>
                  <Icon name="ti-refresh" />
                  {t().retry}
                </Button>
              </Show>
              <Button variant="secondary" onClick={() => navigate("/")}>
                {t().toMyNotes}
              </Button>
            </div>
          </main>
        </Match>
      </Switch>
    </div>
  );
}
