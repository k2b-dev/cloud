import { PermissionEditor } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { RailShortcut } from "@k2b/cloud/contracts";
import { RailAccessSchema, type RailAdminEntry, RailAdminInputSchema, RailAdminSchema, type RailAdminState } from "@k2b/cloud/contracts";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { IconInput, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Check,
  Choice,
  Dialog,
  Field,
  Input,
  type NavProps,
  Notice,
  Pane,
  Path,
  Section,
  Select,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { railAdminMessages } from "./messages";

export const NAVIGATION_PATH = "/admin/apps/navigation";

type AppOption = { id: string; label: string; icon: string };
type Copy = ReturnType<typeof railAdminMessages.resolve>["t"];

const persist = async (value: RailAdminState, t: Copy) => {
  const response = await coreClient.admin.core.rail.$put({ json: RailAdminInputSchema.parse(value) });
  if (!response.ok) throw new Error(response.status === 409 ? t.conflict : t.error);
  return RailAdminSchema.parse(await response.json());
};
const everyoneAccess = () =>
  RailAccessSchema.parse({
    id: crypto.randomUUID(),
    principal: { type: "authenticated" },
    permission: "read",
    createdAt: new Date().toISOString(),
  });
const v2Icon = (icon: string) => icon.replace(/^ti\s+/, "").replace(/^ti-/, "");

export type NavigationScreenProps = {
  nav: NavProps;
  initial: RailAdminState;
  apps: AppOption[];
  /** The open shortcut from the address: an id, "new", or none. */
  open: string | null;
};

/**
 * The shortcuts every person finds in the app bar, a section of Apps on v2: the ordered list, and the open shortcut
 * beside it as a form with its audience. Saving writes the whole bar, as before; a change elsewhere is a conflict.
 */
export default function NavigationScreen(props: NavigationScreenProps) {
  const locale = useLocale();
  const t = () => railAdminMessages.resolve([locale()]).t;
  const toast = useToast();
  const [state, setState] = createSignal(props.initial);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [cacheBusy, setCacheBusy] = createSignal(false);
  const opened = () =>
    props.open && props.open !== "new" ? props.initial.entries.find((entry) => entry.shortcut.id === props.open) : undefined;
  const blank = (): RailAdminEntry => ({
    shortcut: { id: crypto.randomUUID(), kind: "link", title: "", href: "", icon: "ti ti-link" },
    access: [everyoneAccess()],
  });
  const start = opened() ?? (props.open === "new" ? blank() : undefined);
  const [entry, setEntry] = createSignal<RailAdminEntry | undefined>(start ? structuredClone(start) : undefined);
  const [restricted, setRestricted] = createSignal(
    start ? !start.access.some((access) => access.principal.type === "authenticated") : false,
  );
  const authenticated = start?.access.find((access) => access.principal.type === "authenticated") ?? everyoneAccess();
  const index = () => state().entries.findIndex((item) => item.shortcut.id === entry()?.shortcut.id);

  const label = (shortcut: RailShortcut) =>
    shortcut.kind === "app" ? (props.apps.find((app) => app.id === shortcut.appId)?.label ?? t().unavailable) : shortcut.title;
  const icon = (shortcut: RailShortcut) =>
    v2Icon(shortcut.kind === "app" ? (props.apps.find((app) => app.id === shortcut.appId)?.icon ?? "apps") : shortcut.icon);
  const audience = (row: RailAdminEntry) =>
    row.access.some((access) => access.principal.type === "authenticated")
      ? t().everyone
      : row.access.length
        ? t().selected({ count: row.access.length })
        : t().nobody;

  const effective = (): RailAdminEntry | undefined => {
    const current = entry();
    if (!current) return undefined;
    return {
      ...current,
      access: restricted() ? current.access.filter((access) => access.principal.type !== "authenticated") : [authenticated],
    };
  };
  const candidate = (): RailAdminState => {
    const current = effective();
    if (!current) return state();
    const exists = state().entries.some((item) => item.shortcut.id === current.shortcut.id);
    return {
      ...state(),
      entries: exists
        ? state().entries.map((item) => (item.shortcut.id === current.shortcut.id ? current : item))
        : [...state().entries, current],
    };
  };
  const valid = () => RailAdminInputSchema.safeParse(candidate()).success;

  /** Writes the bar; `leave` returns to the list afterwards. */
  const write = async (next: RailAdminState, leave: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setState(await persist(next, t()));
      if (leave) navigateTo(NAVIGATION_PATH);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().error);
    } finally {
      setBusy(false);
    }
  };
  const move = (offset: number) => {
    const entries = [...state().entries];
    const [item] = entries.splice(index(), 1);
    if (!item) return;
    entries.splice(index() + offset, 0, item);
    void write({ ...state(), entries }, false);
  };
  const remove = async () => {
    const current = entry();
    if (!current || !(await Dialog.confirm({ title: t().deleteConfirm, confirm: t().remove }))) return;
    await write({ ...state(), entries: state().entries.filter((item) => item.shortcut.id !== current.shortcut.id) }, true);
  };
  const clearCache = async () => {
    setCacheBusy(true);
    try {
      const response = await coreClient.admin.core.rail.cache.$delete({});
      toast(response.ok ? t().cacheCleared : t().cacheError, { status: response.ok ? "ok" : "bad" });
    } catch {
      toast(t().cacheError, { status: "bad" });
    } finally {
      setCacheBusy(false);
    }
  };
  const update = (shortcut: RailShortcut) => setEntry((current) => (current ? { ...current, shortcut } : current));
  const link = () => {
    const shortcut = entry()?.shortcut;
    return shortcut?.kind === "link" ? shortcut : undefined;
  };
  const appId = () => {
    const shortcut = entry()?.shortcut;
    return shortcut?.kind === "app" ? shortcut.appId : undefined;
  };
  const updateLink = (changes: Partial<Extract<RailShortcut, { kind: "link" }>>) => {
    const current = link();
    if (current) update({ ...current, ...changes });
  };
  const newAction = { label: t().newShortcut, icon: "plus", href: `${NAVIGATION_PATH}?shortcut=new` };

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={460}
      detailEmpty={{ icon: "layout-sidebar", text: t().noneOpen }}
      primary={newAction}
      head={
        <Bar
          start={<Path label={t().apps} items={[{ label: t().apps, href: "/admin/apps" }, { label: t().title }]} />}
          end={
            <Button variant="primary" icon="plus" href={newAction.href}>
              {t().newShortcut}
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().title}
          width={{ min: 420, default: 640 }}
          scrollKey="admin-navigation"
          status={<StatusRow lead={t().shortcuts({ count: state().entries.length })} />}
        >
          <Text muted>{t().description}</Text>
          <Table
            label={t().title}
            rows={state().entries}
            rowKey={(row) => row.shortcut.id}
            current={props.open ?? undefined}
            open={(row) => ({ href: `${NAVIGATION_PATH}?shortcut=${row.shortcut.id}` })}
            empty={{ icon: "layout-sidebar", text: t().empty, action: newAction }}
            phone={(row) => ({ lines: [label(row.shortcut), audience(row)] })}
            columns={[
              {
                title: t().name,
                width: { min: 200, default: 260 },
                cell: (row) => ({
                  lines: [label(row.shortcut), row.shortcut.kind === "app" ? row.shortcut.appId : row.shortcut.href],
                }),
              },
              {
                title: t().type,
                width: { min: 90, default: 110 },
                drop: true,
                cell: (row) => (row.shortcut.kind === "app" ? t().app : t().link),
              },
              { title: t().audience, cell: audience },
            ]}
          />
          <Section
            icon="database-cog"
            title={t().cacheTitle}
            summary={t().cacheHint}
            actions={[{ label: t().clearCache, icon: "eraser", onClick: () => void clearCache(), disabled: cacheBusy() }]}
          />
        </Pane>
        {entry() ? (
          <Pane
            detail
            label={opened() ? t().edit : t().newShortcut}
            back={{ label: t().title, href: NAVIGATION_PATH }}
            head={
              <Bar
                start={<Text type="body">{opened() ? label(opened()!.shortcut) : t().newShortcut}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={NAVIGATION_PATH} />}
              />
            }
          >
            <Show when={error()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
            <Field name="kind" label={t().type}>
              <Choice
                name="kind"
                value={entry()?.shortcut.kind}
                disabled={busy()}
                options={[
                  { value: "app", label: t().app },
                  { value: "link", label: t().link },
                ]}
                onChange={(kind) => {
                  const current = entry();
                  if (!current || kind === current.shortcut.kind) return;
                  if (kind === "app") update({ id: current.shortcut.id, kind, appId: props.apps[0]?.id ?? "" });
                  if (kind === "link") update({ id: current.shortcut.id, kind, title: "", href: "", icon: "ti ti-link" });
                }}
              />
            </Field>
            <Show
              when={entry()?.shortcut.kind === "app"}
              fallback={
                <>
                  <Field name="title" label={t().name}>
                    <Input value={link()?.title ?? ""} disabled={busy()} onInput={(title) => updateLink({ title })} />
                  </Field>
                  <Field name="href" label={t().url} hint={t().urlHint}>
                    <Input type="url" value={link()?.href ?? ""} disabled={busy()} onInput={(href) => updateLink({ href })} />
                  </Field>
                  <Field name="icon" label={t().icon}>
                    {/* k2b-ui gap: no icon picker in v2; the v1 picker stands in. */}
                    <IconInput
                      label={t().icon}
                      value={() => link()?.icon ?? "ti ti-link"}
                      clearable={false}
                      onValueChange={(value) => updateLink({ icon: value ?? "ti ti-link" })}
                    />
                  </Field>
                </>
              }
            >
              <Field name="app" label={t().app}>
                <Select
                  placeholder={t().chooseApp}
                  options={props.apps.map((app) => ({ value: app.id, label: app.label }))}
                  value={appId()}
                  onChange={(appId) => {
                    const current = entry();
                    if (current && appId) update({ id: current.shortcut.id, kind: "app", appId });
                  }}
                />
              </Field>
            </Show>
            <Check switch label={t().restrictAudience} checked={restricted()} disabled={busy()} onChange={setRestricted} />
            <Text type="meta" muted>
              {restricted() ? t().audienceHint : t().restrictAudienceHint}
            </Text>
            <Show when={restricted()}>
              {/* k2b-ui gap: the access editor is not on v2 yet. It stays inline (rule inline-access-editors): it picks the
                  shortcut's audience inside its own form and saves with that form's Save. */}
              <PermissionEditor
                initialEntries={entry()?.access.filter((access) => access.principal.type !== "authenticated") ?? []}
                canEdit={!busy()}
                allowPublic={false}
                allowAuthenticated={false}
                allowServiceAccounts={false}
                allowedLevels={[{ level: "read", label: t().show }]}
                grantAccess={async (principal, permission, display) => {
                  const access = RailAccessSchema.parse({
                    id: crypto.randomUUID(),
                    principal,
                    permission,
                    createdAt: new Date().toISOString(),
                    displayName: display?.displayName,
                  });
                  setEntry((current) => (current ? { ...current, access: [...current.access, access] } : current));
                  return access;
                }}
                updateAccess={async () => {
                  /* The only offered level is read. */
                }}
                revokeAccess={async (id) => {
                  setEntry((current) => (current ? { ...current, access: current.access.filter((access) => access.id !== id) } : current));
                }}
              />
            </Show>
            <Show when={!valid()}>
              <Notice tone="warn">{t().invalid}</Notice>
            </Show>
            <Bar
              start={
                <Show when={opened()}>
                  <Button variant="text" icon="arrow-up" label={t().up} disabled={busy() || index() <= 0} onClick={() => move(-1)} />
                  <Button
                    variant="text"
                    icon="arrow-down"
                    label={t().down}
                    disabled={busy() || index() === state().entries.length - 1}
                    onClick={() => move(1)}
                  />
                  <Button variant="text" icon="trash" disabled={busy()} onClick={() => void remove()}>
                    {t().remove}
                  </Button>
                </Show>
              }
              end={
                <>
                  <Button href={NAVIGATION_PATH} disabled={busy()}>
                    {t().cancel}
                  </Button>
                  <Button busy={busy()} disabled={!valid()} onClick={() => void write(candidate(), true)}>
                    {t().save}
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
