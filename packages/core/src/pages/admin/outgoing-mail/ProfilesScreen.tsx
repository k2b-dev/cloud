import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Dialog,
  Field,
  Input,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Path,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { OUTGOING_MAIL_HREF } from "./area";
import { outgoingMailMessages } from "./messages";
import ProfileForm from "./ProfileForm";
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
      detail={480}
      detailEmpty={{ icon: "mail-cog", text: t().noneOpen }}
      primary={newAction}
      head={
        <Bar
          start={<Path label={t().title} items={[{ label: t().title, href: PATH }, { label: t().profiles }]} />}
          end={
            <Button variant="primary" icon="plus" href={newAction.href}>
              {t().addProfile}
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().profiles}
          width={{ min: 420, default: 640 }}
          scrollKey="admin-outgoing-mail-profiles"
          status={<StatusRow lead={t().profileCount({ count: props.profiles.length })} />}
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
              lines: [row.name, row.fromAddress],
              marks: row.isDefault ? <Chip tag>{t().defaultBadge}</Chip> : undefined,
            })}
            columns={[
              {
                title: t().profile,
                width: { min: 180, default: 220 },
                cell: (row) => ({ lines: [row.isDefault ? `${row.name} · ${t().defaultBadge}` : row.name, row.key] }),
              },
              {
                title: t().sender,
                width: { min: 180, default: 220 },
                cell: (row) => ({ lines: [row.fromAddress, row.fromName ?? t().fromAppName] }),
              },
              {
                title: t().server,
                width: { min: 180, default: 220 },
                drop: true,
                cell: (row) => ({ lines: [`${row.smtpHost}:${row.smtpPort}`, row.bounceText] }),
              },
              {
                title: t().limits,
                drop: true,
                cell: (row) => ({
                  lines: [
                    t().perMinute({ count: row.pacePerMinute }),
                    row.dailyRecipientLimit ? t().perDay({ count: row.dailyRecipientLimit }) : t().unlimited,
                  ],
                }),
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
