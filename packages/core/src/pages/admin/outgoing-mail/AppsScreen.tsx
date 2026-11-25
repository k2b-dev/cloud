import type { AdminMailApp, AdminMailProfile } from "@k2b/cloud/contracts";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Check, Choice, Field, type NavProps, Notice, Pane, Path, Section, Select, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { OUTGOING_MAIL_HREF } from "./area";
import { outgoingMailMessages } from "./messages";
import { type AccessMode, accessLabel, api, CORE_APP_ID, failure, logLabel } from "./shared";

const PATH = OUTGOING_MAIL_HREF.apps;

/** Which profiles an app may send with: the default one, chosen ones, or none. */
const SendAccess = (props: { app: AdminMailApp; profiles: readonly AdminMailProfile[] }) => {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  const initialMode: AccessMode = props.app.mode === "default" ? "default" : props.app.profiles.length ? "selected" : "none";
  const [mode, setMode] = createSignal<AccessMode>(initialMode);
  const [selected, setSelected] = createSignal<string[]>(props.app.profiles);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const defaultProfile = () => props.profiles.find((profile) => profile.isDefault);
  const valid = () => mode() !== "selected" || selected().length > 0;
  const hint = () =>
    mode() === "default"
      ? defaultProfile()
        ? t().accessDefaultHint({ name: defaultProfile()!.name })
        : t().accessDefaultHintNone
      : mode() === "selected"
        ? t().accessSelectedHint
        : t().accessNoneHint;
  // Every mode shows the same profiles, read-only outside "Selected profiles", so the form keeps its height.
  const usable = (profile: AdminMailProfile) =>
    mode() === "selected" ? selected().includes(profile.key) : mode() === "default" && profile.isDefault;
  const save = async () => {
    if (!valid() || saving()) return;
    setSaving(true);
    setError(null);
    try {
      const json =
        mode() === "default" ? { mode: "default" as const } : { mode: "selected" as const, profiles: mode() === "none" ? [] : selected() };
      const response = await api.apps[":appId"].$put({ param: { appId: props.app.appId }, json });
      if (!response.ok) throw await failure(response, t().accessFailed, t());
      navigateTo(`${PATH}?app=${encodeURIComponent(props.app.appId)}`);
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : t().accessFailed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section icon="mail-share" title={t().senderAccess} summary={hint()}>
      <Show when={!props.app.declared}>
        <Notice tone="warn">{t().notDeclaredNotice}</Notice>
      </Show>
      <Field name="mode" label={t().access}>
        <Choice
          name="mode"
          value={mode()}
          disabled={saving()}
          options={[
            { value: "default", label: t().accessDefault },
            { value: "selected", label: t().accessSelected },
            { value: "none", label: t().accessNone },
          ]}
          onChange={(value) => setMode(value === "selected" ? "selected" : value === "none" ? "none" : "default")}
        />
      </Field>
      <For each={props.profiles}>
        {(profile) => (
          <Check
            label={`${profile.name} · ${profile.fromAddress}`}
            checked={usable(profile)}
            disabled={saving() || mode() !== "selected"}
            onChange={(checked) =>
              setSelected((current) => (checked ? [...new Set([...current, profile.key])] : current.filter((key) => key !== profile.key)))
            }
          />
        )}
      </For>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" title={t().accessFailed}>
            {message()}
          </Notice>
        )}
      </Show>
      <Bar
        end={
          <Button busy={saving()} disabled={!valid()} onClick={() => void save()}>
            {t().save}
          </Button>
        }
      />
    </Section>
  );
};

/** Whose send log an app may read besides its own: per other app none, metadata or content. */
const LogAccess = (props: { app: AdminMailApp; apps: readonly AdminMailApp[] }) => {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  const [selected, setSelected] = createSignal<string[]>(props.app.logApps);
  const [content, setContent] = createSignal<string[]>(props.app.logContentApps ?? []);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Core's system email is never readable by apps; grants for apps that went offline stay visible.
  const candidates = () =>
    [
      ...props.apps.filter((app) => app.appId !== props.app.appId && app.appId !== CORE_APP_ID),
      ...props.app.logApps
        .filter((id) => !props.apps.some((app) => app.appId === id))
        .map((id): Pick<AdminMailApp, "appId" | "name" | "registered"> => ({ appId: id, name: id, registered: false })),
    ].sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId));
  const choose = (appId: string, level: string) => {
    setSelected((current) => (level === "none" ? current.filter((id) => id !== appId) : [...new Set([...current, appId])]));
    setContent((current) => (level === "content" ? [...new Set([...current, appId])] : current.filter((id) => id !== appId)));
  };
  const save = async () => {
    if (saving()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.apps[":appId"]["log-access"].$put({
        param: { appId: props.app.appId },
        json: { apps: selected(), contentApps: content() },
      });
      if (!response.ok) throw await failure(response, t().logAccessFailed, t());
      navigateTo(`${PATH}?app=${encodeURIComponent(props.app.appId)}`);
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : t().logAccessFailed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section icon="list-search" title={t().logAccessTitle} summary={t().logAccessHint}>
      <Show when={!props.app.readDeclared}>
        <Notice tone="warn">{t().logAccessNotDeclared}</Notice>
      </Show>
      <Text type="meta" muted>
        {`${t().logMetadataHint} ${t().logContentHint}`}
      </Text>
      <Show when={candidates().length} fallback={<Text muted>{t().noOtherApps}</Text>}>
        <For each={candidates()}>
          {(app) => (
            <Field
              name={`log-${app.appId}`}
              label={app.name}
              hint={
                !app.registered
                  ? t().notRegistered
                  : candidates().some((other) => other.appId !== app.appId && other.name === app.name)
                    ? app.appId
                    : undefined
              }
            >
              {/* k2b-ui gap: Select takes no `disabled`; while saving a choice is ignored. */}
              <Select
                value={content().includes(app.appId) ? "content" : selected().includes(app.appId) ? "metadata" : "none"}
                options={[
                  { value: "none", label: t().logNoAccess },
                  { value: "metadata", label: t().logMetadata },
                  { value: "content", label: t().logContent },
                ]}
                onChange={(level) => {
                  if (!saving()) choose(app.appId, level || "none");
                }}
              />
            </Field>
          )}
        </For>
      </Show>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" title={t().logAccessFailed}>
            {message()}
          </Notice>
        )}
      </Show>
      <Bar
        end={
          <Button busy={saving()} onClick={() => void save()}>
            {t().save}
          </Button>
        }
      />
    </Section>
  );
};

/**
 * Which app may send mail with which profile and read whose send log, on v2: the apps, and the open app beside it with
 * both kinds of access. Core's system mail always uses the default profile and opens nothing.
 */
export default function AppsScreen(props: {
  nav: NavProps;
  profiles: AdminMailProfile[];
  apps: AdminMailApp[];
  /** The open app from the address (`?app=`). */
  open: string | null;
}) {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  const sorted = () => [...props.apps].sort((a, b) => Number(b.declared) - Number(a.declared) || a.name.localeCompare(b.name));
  const opened = () => (props.open ? props.apps.find((app) => app.appId === props.open) : undefined);
  const state = (app: AdminMailApp) =>
    app.appId === CORE_APP_ID ? t().systemMail : !app.registered ? t().notRegistered : app.declared ? t().requested : t().notRequested;
  return (
    <AdminWorkspace
      nav={props.nav}
      detail={460}
      detailEmpty={{ icon: "apps", text: t().noAppOpen }}
      head={
        <Bar start={<Path label={t().title} items={[{ label: t().title, href: OUTGOING_MAIL_HREF.profiles }, { label: t().apps }]} />} />
      }
    >
      <Pane.Split>
        <Pane
          label={t().apps}
          width={{ min: 420, default: 640 }}
          scrollKey="admin-outgoing-mail-apps"
          status={<StatusRow lead={t().appCount({ count: props.apps.length })} />}
        >
          <Text muted>{t().appsDescription}</Text>
          <Table
            label={t().apps}
            rows={sorted()}
            rowKey={(row) => row.appId}
            current={props.open ?? undefined}
            open={(row) => ({ href: `${PATH}?app=${encodeURIComponent(row.appId)}` })}
            empty={{ icon: "apps", text: t().noApps }}
            phone={(row) => ({ lines: [row.name, accessLabel(row, props.profiles, t())] })}
            columns={[
              { title: t().app, width: { min: 180, default: 220 }, cell: (row) => ({ lines: [row.name, state(row)] }) },
              { title: t().access, width: { min: 180, default: 220 }, cell: (row) => accessLabel(row, props.profiles, t()) },
              {
                title: t().logAccess,
                drop: true,
                cell: (row) => (row.appId === CORE_APP_ID ? "–" : logLabel(row, props.apps, t())),
              },
            ]}
          />
        </Pane>
        {opened() ? (
          <Pane
            detail
            label={opened()!.name}
            back={{ label: t().apps, href: PATH }}
            head={
              <Bar
                start={<Text type="body">{opened()!.name}</Text>}
                end={<Button variant="ghost" icon="x" label={t().cancel} href={PATH} />}
              />
            }
          >
            {/* Core's system mail (sign-in links, notifications) always uses the default profile and reads no log. */}
            <Show
              when={opened()!.appId !== CORE_APP_ID}
              fallback={<Notice tone="note">{accessLabel(opened()!, props.profiles, t())}</Notice>}
            >
              <SendAccess app={opened()!} profiles={props.profiles} />
              <LogAccess app={opened()!} apps={props.apps} />
            </Show>
          </Pane>
        ) : undefined}
      </Pane.Split>
    </AdminWorkspace>
  );
}
