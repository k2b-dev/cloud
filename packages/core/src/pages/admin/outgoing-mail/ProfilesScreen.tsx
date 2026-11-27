import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Dialog, Field, Input, Menu, type NavProps, Notice, Pane, StatusRow, Table, Text, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { outgoingMailMessages } from "./messages";
import ProfileForm from "./ProfileForm";
import { OUTGOING_MAIL_HREF } from "./paths";
import { api, failure } from "./shared";

/** A profile as the list shows it, with its bounce check worded by the server. */
export type ProfileRow = AdminMailProfile & { bounceText: string; bounceFailed: boolean };

const PATH = OUTGOING_MAIL_HREF.profiles;

/** Sends one test mail with a profile; the dialog stays open with the reason when it fails. */
const TestDialog = (props: { profile: AdminMailProfile | null; onClose: () => void }) => {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  const toast = useToast();
  const [recipient, setRecipient] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const send = async () => {
    const profile = props.profile;
    if (!profile || !recipient().trim() || sending()) return;
    setSending(true);
    setError(null);
    try {
      const response = await api.profiles[":key"].test.$post({ param: { key: profile.key }, json: { recipient: recipient().trim() } });
      if (!response.ok) throw await failure(response, t().testFailed, t());
      toast(t().testSent({ recipient: recipient().trim() }), { status: "ok" });
      props.onClose();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : t().testFailed);
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog
      title={t().testTitle}
      open={props.profile !== null}
      dismissible={!sending()}
      onOpenChange={(open) => {
        if (!open && !sending()) props.onClose();
      }}
      foot={
        <>
          <Button disabled={sending()} onClick={props.onClose}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="send" busy={sending()} disabled={!recipient().trim()} onClick={() => void send()}>
            {t().send}
          </Button>
        </>
      }
    >
      <Text>{t().testDescription({ name: props.profile?.name ?? "" })}</Text>
      <Field name="recipient" label={t().recipient} required>
        <Input
          type="email"
          value={recipient()}
          disabled={sending()}
          onInput={setRecipient}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void send();
          }}
        />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" title={t().testFailed}>
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
};

/**
 * The sender profiles of Outgoing mail on v2: the list, and the open profile beside it as a form with its deeds (send
 * a test, make it the default, delete it). What is open lives in the address (`?profile=`).
 */
export default function ProfilesScreen(props: { nav: NavProps; profiles: ProfileRow[]; open: string | null }) {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  /** A count in the figures of the page's language, such as "1.284". */
  const count = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const toast = useToast();
  const [testing, setTesting] = createSignal<AdminMailProfile | null>(null);
  const opened = () => (props.open && props.open !== "new" ? props.profiles.find((profile) => profile.key === props.open) : undefined);
  const creating = () => props.open === "new";
  const refresh = () => navigateTo(PATH);

  const makeDefault = async (profile: AdminMailProfile) => {
    if (
      !(await Dialog.confirm({
        title: t().defaultTitle,
        description: t().defaultConfirm({ name: profile.name }),
        confirm: t().makeDefault,
      }))
    )
      return;
    const response = await api.profiles[":key"].default.$post({ param: { key: profile.key } });
    if (!response.ok) return void toast((await failure(response, t().defaultFailed, t())).message, { status: "bad" });
    navigateTo(`${PATH}?profile=${profile.key}`);
  };
  const remove = async (profile: AdminMailProfile) => {
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    if (!(await Dialog.confirm({ title: t().deleteTitle, description: t().deleteConfirm({ name: profile.name }), confirm: t().delete })))
      return;
    const response = await api.profiles[":key"].$delete({ param: { key: profile.key } });
    if (!response.ok) return void toast((await failure(response, t().deleteFailed, t())).message, { status: "bad" });
    refresh();
  };
  const newAction = { label: t().addProfile, icon: "plus", href: `${PATH}?profile=new` };

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while something is open: no empty half (identity rule 5)
      detail={creating() || opened() ? 480 : undefined}
      detailEmpty={{ icon: "mail-cog", text: t().noneOpen }}
      // on the phone the main action floats over the list only; an open entry is a page of its own without it
      primary={creating() || opened() ? undefined : newAction}
      head={<Bar end={<Button variant="primary" icon="plus" label={t().addProfile} href={newAction.href} />} />}
    >
      <Pane.Split>
        <Pane
          label={t().profiles}
          // the list keeps its ideal width beside an open entry and takes the room while none is open (identity rule 5)
          width={creating() || opened() ? { min: 420, default: 640 } : undefined}
          scrollKey="admin-outgoing-mail-profiles"
          status={
            // the screen's figure: recipients of the last 24 hours over every profile, from the admin contract (no series
            // exists, so no trend); k2b-ui gap: the hero band in figure type comes with DP
            <StatusRow
              lead={t().recipients24h({ count: count(props.profiles.reduce((sum, row) => sum + row.usedLast24h, 0)) })}
              facts={[{ value: t().profileCount({ count: props.profiles.length }) }]}
            />
          }
        >
          <Text muted>{t().profilesDescription}</Text>
          <Table
            label={t().profiles}
            rows={props.profiles}
            rowKey={(row) => row.key}
            current={props.open ?? undefined}
            open={(row) => ({ href: `${PATH}?profile=${row.key}` })}
            empty={{ icon: "mail-off", text: t().noProfilesDescription, action: newAction }}
            phone={(row) => ({
              lines: [row.isDefault ? `${row.name} · ${t().defaultBadge}` : row.name, row.fromAddress],
            })}
            // one line per row (identity rule 4); the server, the pace and the bounce mailbox are in the open profile
            columns={[
              {
                title: t().profile,
                width: { min: 180, default: 220 },
                mark: () => ({ icon: "mail-cog" }),
                // a plain value, so a long name is cut with "…" and says itself on hover
                cell: (row) => (row.isDefault ? `${row.name} · ${t().defaultBadge}` : row.name),
              },
              // three columns fit beside an open profile; the server, pace and daily limit are in the profile
              { title: t().sender, width: { min: 160, default: 200 }, drop: true, cell: (row) => row.fromAddress },
              // each profile's recipients in 24 hours; no bar, because the daily limit applies per app, not to this sum
              { title: t().last24h, width: { min: 90, default: 100 }, align: "end", cell: (row) => count(row.usedLast24h) },
              {
                title: t().state,
                width: { min: 180, default: 200 },
                drop: true,
                cell: (row) => (row.bounceFailed ? <Chip status="bad">{t().bounceProblem}</Chip> : ""),
              },
            ]}
          />
        </Pane>
        {creating() || opened() ? (
          <Pane
            detail
            label={opened() ? t().editProfile : t().newProfile}
            back={{ label: t().profiles, href: PATH }}
            head={
              <Bar
                start={<Text type="body">{opened()?.name ?? t().newProfile}</Text>}
                end={<Button variant="ghost" icon="x" label={t().cancel} href={PATH} />}
              />
            }
          >
            <Show when={opened()?.bounceFailed}>
              <Notice tone="warn" icon="mail-exclamation">
                {opened()?.bounceText}
              </Notice>
            </Show>
            <ProfileForm
              profile={opened()}
              cancelHref={PATH}
              onSaved={refresh}
              start={
                opened() ? (
                  <Menu
                    label={t().profileActions({ name: opened()!.name })}
                    items={[
                      { label: t().sendTest, icon: "send", onClick: () => setTesting(opened() ?? null) },
                      ...(opened()!.isDefault
                        ? []
                        : [
                            { label: t().makeDefault, icon: "star", onClick: () => void makeDefault(opened()!) },
                            { label: t().delete, icon: "trash", danger: true, onClick: () => void remove(opened()!) },
                          ]),
                    ]}
                  />
                ) : undefined
              }
            />
          </Pane>
        ) : undefined}
      </Pane.Split>
      <TestDialog profile={testing()} onClose={() => setTesting(null)} />
    </AdminWorkspace>
  );
}
