import { coreClient } from "@k2b/cloud/clients/core";
import type { AnnouncementEntry } from "@k2b/cloud/contracts";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Choice,
  Dialog,
  Field,
  Input,
  type NavProps,
  Notice,
  Pane,
  Select,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import CacheSection from "../_area/CacheSection";
import { adminMessages } from "../messages";

export const ANNOUNCEMENTS_PATH = "/admin/announcements";

/** One entry as the list shows it: the stored entry, its state now, and its times worded by the server. */
export type AnnouncementRow = AnnouncementEntry & { state: "scheduled" | "expired" | "active"; published: string; expires: string };

export type AnnouncementsScreenProps = {
  nav: NavProps;
  rows: AnnouncementRow[];
  /** The open entry from the address: an id, "new", or none. */
  open: string | null;
};

type Draft = {
  kind: AnnouncementEntry["kind"];
  title: string;
  body: string;
  tone: AnnouncementEntry["tone"];
  publishedAt: string;
  expiresAt: string;
};

const toIso = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
};
const STATUS = { active: "ok", scheduled: "warn", expired: "bad" } as const;

/**
 * Announcements and banners on v2: the list with its key figures, and the open entry beside it as a form that creates,
 * saves or deletes it through the announcements API. What is open lives in the address (`?entry=`).
 */
export default function AnnouncementsScreen(props: AnnouncementsScreenProps) {
  const locale = useLocale();
  const t = () => adminMessages.resolve([locale()]).t;
  const toast = useToast();
  const entry = () => (props.open && props.open !== "new" ? props.rows.find((row) => row.id === props.open) : undefined);
  const creating = () => props.open === "new";
  const blank = (): Draft => ({ kind: "announcement", title: "", body: "", tone: "info", publishedAt: "", expiresAt: "" });
  const fromEntry = (row: AnnouncementEntry): Draft => ({
    kind: row.kind,
    title: row.title,
    body: row.body,
    tone: row.tone,
    publishedAt: row.publishedAt,
    expiresAt: row.expiresAt ?? "",
  });
  const [draft, setDraft] = createSignal<Draft>(entry() ? fromEntry(entry()!) : blank());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [tried, setTried] = createSignal(false);
  const change = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const count = (state: AnnouncementRow["state"]) => props.rows.filter((row) => row.state === state).length;
  const message = async (response: { json(): Promise<unknown> }, fallback: string) => {
    const body = await response.json().catch(() => null);
    return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
  };

  const save = async () => {
    setTried(true);
    const value = draft();
    if (!value.title.trim() || !value.body.trim()) return;
    setBusy(true);
    setError(null);
    const current = entry();
    try {
      const payload = {
        kind: value.kind,
        title: value.title.trim(),
        body: value.body.trim(),
        tone: value.tone,
        publishedAt: toIso(value.publishedAt),
      };
      const response = current
        ? await coreClient.admin.core.announcements[":id"].$patch({
            param: { id: current.id },
            json: { ...payload, expiresAt: toIso(value.expiresAt) ?? null },
          })
        : await coreClient.admin.core.announcements.$post({ json: { ...payload, expiresAt: toIso(value.expiresAt) } });
      if (!response.ok) throw new Error(await message(response, current ? t().updateFailed : t().createFailed));
      toast(current ? t().updated : t().created, { status: "ok" });
      navigateTo(ANNOUNCEMENTS_PATH);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().updateFailed);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const current = entry();
    if (!current) return;
    if (!(await Dialog.confirm({ title: t().deleteConfirm({ title: current.title }), confirm: t().delete }))) return;
    setBusy(true);
    try {
      const response = await coreClient.admin.core.announcements[":id"].$delete({ param: { id: current.id } });
      if (!response.ok) throw new Error(await message(response, t().deleteFailed));
      toast(t().deleted, { status: "ok" });
      navigateTo(ANNOUNCEMENTS_PATH);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().deleteFailed);
    } finally {
      setBusy(false);
    }
  };
  const required = (value: string) => (tried() && !value.trim() ? t().required : undefined);
  const newAction = { label: t().newAnnouncement, icon: "plus", href: `${ANNOUNCEMENTS_PATH}?entry=new` };

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={460}
      detailEmpty={{ icon: "speakerphone", text: t().noneOpen }}
      primary={newAction}
      head={
        <Bar
          start={<Text type="body">{t().announcements}</Text>}
          end={
            <Button variant="primary" icon="plus" href={newAction.href}>
              {t().newAnnouncement}
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().announcements}
          width={{ min: 420, default: 640 }}
          scrollKey="admin-announcements"
          status={
            <StatusRow
              lead={t().entriesCount({ count: props.rows.length })}
              facts={[
                { value: String(count("active")), after: t().activeLower },
                { value: String(count("scheduled")), after: t().scheduledLower },
              ]}
            />
          }
        >
          <Table
            label={t().announcements}
            rows={props.rows}
            rowKey={(row) => row.id}
            current={props.open ?? undefined}
            open={(row) => ({ href: `${ANNOUNCEMENTS_PATH}?entry=${row.id}` })}
            empty={{ icon: "speakerphone", text: t().noAnnouncements, action: newAction }}
            phone={(row) => ({
              lines: [row.title, `${t()[row.state]} · ${row.kind === "banner" ? t().banner : t().announcement} · ${row.published}`],
            })}
            columns={[
              {
                title: t().title,
                width: { min: 200, default: 280 },
                cell: (row) => ({ lines: [row.title, row.kind === "banner" ? t().banner : t().announcement] }),
              },
              {
                title: t().state,
                width: { min: 110, default: 130 },
                cell: (row) => <Chip status={STATUS[row.state]}>{t()[row.state]}</Chip>,
              },
              { title: t().published, width: { min: 140, default: 160 }, drop: true, cell: (row) => row.published },
              { title: t().expires, drop: true, cell: (row) => row.expires },
            ]}
          />
          <CacheSection area="announcements" />
        </Pane>
        {props.open && (creating() || entry()) ? (
          <Pane
            detail
            label={creating() ? t().newAnnouncement : t().editAnnouncement}
            back={{ label: t().announcements, href: ANNOUNCEMENTS_PATH }}
            head={
              <Bar
                start={<Text type="body">{creating() ? t().newAnnouncement : (entry()?.title ?? "")}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={ANNOUNCEMENTS_PATH} />}
              />
            }
          >
            <Show when={error()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
            <Field name="kind" label={t().type} hint={draft().kind === "banner" ? t().bannerDescription : t().announcementDescription}>
              <Choice
                name="kind"
                value={draft().kind}
                disabled={busy()}
                options={[
                  { value: "announcement", label: t().announcement },
                  { value: "banner", label: t().banner },
                ]}
                onChange={(value) => change({ kind: value === "banner" ? "banner" : "announcement" })}
              />
            </Field>
            <Field name="title" label={t().title} hint={t().titleDescription} error={required(draft().title)} required>
              <Input value={draft().title} disabled={busy()} onInput={(value) => change({ title: value })} />
            </Field>
            <Field name="body" label={t().body} hint={t().bodyDescription} error={required(draft().body)} required>
              <Input multiline value={draft().body} disabled={busy()} onInput={(value) => change({ body: value })} />
            </Field>
            <Field name="tone" label={t().tone} hint={t().toneDescription}>
              <Select
                value={draft().tone}
                options={[
                  { value: "info", label: t().info },
                  { value: "success", label: t().success },
                  { value: "warning", label: t().warning },
                  { value: "danger", label: t().danger },
                ]}
                onChange={(value) => {
                  if (value === "info" || value === "success" || value === "warning" || value === "danger") change({ tone: value });
                }}
              />
            </Field>
            {/* k2b-ui gap: no date and time picker; a point in time is typed as ISO text as before. */}
            <Field.Row>
              <Field name="publishedAt" label={t().publishDate} hint={t().publishDateDescription} optional={t().optional}>
                <Input
                  value={draft().publishedAt}
                  placeholder="2026-12-01T08:00"
                  disabled={busy()}
                  onInput={(value) => change({ publishedAt: value })}
                />
              </Field>
              <Field name="expiresAt" label={t().expiryDate} hint={t().expiryDateDescription} optional={t().optional}>
                <Input
                  value={draft().expiresAt}
                  placeholder={t().noExpiry}
                  disabled={busy()}
                  onInput={(value) => change({ expiresAt: value })}
                />
              </Field>
            </Field.Row>
            <Bar
              start={
                <Show when={entry()}>
                  <Button variant="text" icon="trash" disabled={busy()} onClick={() => void remove()}>
                    {t().delete}
                  </Button>
                </Show>
              }
              end={
                <>
                  <Button href={ANNOUNCEMENTS_PATH} disabled={busy()}>
                    {t().cancel}
                  </Button>
                  <Button busy={busy()} onClick={() => void save()}>
                    {creating() ? t().create : t().save}
                  </Button>
                </>
              }
            />
          </Pane>
        ) : undefined}
      </Pane.Split>
    </AdminWorkspace>
  );
}
