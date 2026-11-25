import { openProfilePictureDialog } from "@k2b/cloud/account/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import type { UserProvider } from "@k2b/cloud/contracts";
import { AvatarStateSchema, SaveAvatarSchema } from "@k2b/cloud/contracts/profile";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Dialog, Field, Input, List, Notice, Row, Text, useToast } from "@k2b/ui/v2";
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { z } from "zod";
import { useAccountMessages } from "./AccountWorkspace";
import { confirmIdentity, SignInNeededError, takeReturnIntent, throwIfSignInNeeded } from "./confirm-identity";

/** What the profile's deeds need to know about the person; plain data, so an island takes it as props. */
export type ProfileActionsUser = {
  provider: UserProvider;
  uid: string;
  givenname: string;
  sn: string;
  displayName: string;
  ipa: {
    phone: string | null;
    address: { street: string | null; postalCode: string | null; city: string | null; state: string | null };
    sshPublicKeys: string[];
  } | null;
};

const SSH_KEY_PATTERN = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+/;
const DETAILS_INTENT = { key: "edit", value: "details" };

const DetailsDraftSchema = z.object({
  phone: z.string(),
  street: z.string(),
  postalCode: z.string(),
  city: z.string(),
  state: z.string(),
  sshKeys: z.array(z.string()),
});
type DetailsDraft = z.infer<typeof DetailsDraftSchema>;

const keyLabel = (key: string): { type: string; comment: string; suffix: string } => {
  const parts = key.split(/\s+/);
  const type = parts[0] ?? "ssh";
  const blob = parts[1] ?? "";
  return { type, comment: parts.slice(2).join(" "), suffix: blob.length > 8 ? `...${blob.slice(-8)}` : blob };
};

/**
 * The deeds on a person's own profile: change the picture, edit the name, edit contact and SSH details, extend the
 * account. Each deed calls the same endpoint as before; the dialogs are v2 and stay open with the error in place when
 * saving fails. `dialogs` must stand once in the screen.
 */
export const useProfileActions = (props: { user: ProfileActionsUser; appName: string; freeIpaEnabled: boolean; details?: boolean }) => {
  const t = useAccountMessages();
  const locale = useLocale();
  const toast = useToast();
  const isIpa = props.user.provider === "ipa" && props.freeIpaEnabled;
  const canMutateAccount = props.user.provider !== "ipa" || props.freeIpaEnabled;
  const holders = () => (props.appName ? t().holdersNamed({ appName: props.appName }) : t().holdersAll);

  // ── Picture ──
  const readAvatar = async (response: { ok: boolean; json: () => Promise<unknown> }) => {
    if (!response.ok) throw new Error(t().avatarSaveFailed);
    return AvatarStateSchema.parse(await response.json());
  };
  const changeAvatar = async () => {
    const changed = await openProfilePictureDialog({
      subject: "person",
      name: props.user.displayName || props.user.uid,
      load: async () => readAvatar(await apiClient.me.avatar.$get()),
      save: async (change) => readAvatar(await apiClient.me.avatar.$put({ json: SaveAvatarSchema.parse(change) })),
      deletePhoto: async () => {
        const deleted = await apiClient.me.avatar.$delete();
        if (!deleted.ok) throw new Error(t().avatarRemoveFailed);
        return readAvatar(await apiClient.me.avatar.$get());
      },
    });
    // The header, rail, and every list read the avatar hash from the page; a reload shows the new picture everywhere.
    if (changed) window.location.reload();
  };

  // ── Name ──
  const [profileOpen, setProfileOpen] = createSignal(false);
  const [givenname, setGivenname] = createSignal(props.user.givenname);
  const [sn, setSn] = createSignal(props.user.sn);
  const [displayName, setDisplayName] = createSignal(props.user.displayName);
  const [profileTried, setProfileTried] = createSignal(false);
  const [profileBusy, setProfileBusy] = createSignal(false);
  const [profileError, setProfileError] = createSignal<string | null>(null);
  const required = (value: string) => (profileTried() && !value.trim() ? t().fieldRequired : undefined);
  const editProfile = () => {
    setGivenname(props.user.givenname);
    setSn(props.user.sn);
    setDisplayName(props.user.displayName);
    setProfileTried(false);
    setProfileError(null);
    setProfileOpen(true);
  };
  const saveProfile = async () => {
    setProfileTried(true);
    if (profileBusy() || !givenname().trim() || !sn().trim() || !displayName().trim()) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      const res = await apiClient.me.$patch({ json: { givenname: givenname(), sn: sn(), displayName: displayName() } }).catch(() => null);
      if (!res?.ok) throw new Error(t().failedToUpdateProfile);
      window.location.reload();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : t().failedToUpdateProfile);
      setProfileBusy(false);
    }
  };

  // ── Contact and SSH details ──
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [phone, setPhone] = createSignal("");
  const [street, setStreet] = createSignal("");
  const [postalCode, setPostalCode] = createSignal("");
  const [city, setCity] = createSignal("");
  const [state, setState] = createSignal("");
  const [keys, setKeys] = createSignal<string[]>([]);
  const [newKey, setNewKey] = createSignal("");
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const [detailsBusy, setDetailsBusy] = createSignal(false);
  const [detailsError, setDetailsError] = createSignal<string | null>(null);
  const editDetails = (draft?: DetailsDraft) => {
    const ipa = props.user.ipa;
    setPhone(draft?.phone ?? ipa?.phone ?? "");
    setStreet(draft?.street ?? ipa?.address.street ?? "");
    setPostalCode(draft?.postalCode ?? ipa?.address.postalCode ?? "");
    setCity(draft?.city ?? ipa?.address.city ?? "");
    setState(draft?.state ?? ipa?.address.state ?? "");
    setKeys([...(draft?.sshKeys ?? ipa?.sshPublicKeys ?? [])]);
    setNewKey("");
    setKeyError(null);
    setDetailsError(null);
    setDetailsOpen(true);
  };
  const addKey = () => {
    const key = newKey().trim();
    if (!key) return;
    if (!SSH_KEY_PATTERN.test(key)) return setKeyError(t().invalidSshKey);
    if (keys().includes(key)) return setKeyError(t().duplicateSshKey);
    setKeys([...keys(), key]);
    setNewKey("");
    setKeyError(null);
  };
  const saveDetails = async () => {
    if (detailsBusy()) return;
    const ipa = props.user.ipa;
    const result: DetailsDraft = {
      phone: phone(),
      street: street(),
      postalCode: postalCode(),
      city: city(),
      state: state(),
      sshKeys: keys(),
    };
    const contactChanged =
      (result.phone || "") !== (ipa?.phone ?? "") ||
      (result.street || "") !== (ipa?.address.street ?? "") ||
      (result.postalCode || "") !== (ipa?.address.postalCode ?? "") ||
      (result.city || "") !== (ipa?.address.city ?? "") ||
      (result.state || "") !== (ipa?.address.state ?? "");
    const sshChanged =
      result.sshKeys.length !== (ipa?.sshPublicKeys.length ?? 0) ||
      result.sshKeys.some((k, i) => k !== (ipa?.sshPublicKeys[i] ?? undefined));
    if (!contactChanged && !sshChanged) return setDetailsOpen(false);
    setDetailsBusy(true);
    setDetailsError(null);
    try {
      const res = await apiClient.me.$patch({
        json: {
          ipa: {
            phone: result.phone || undefined,
            address: {
              street: result.street || undefined,
              postalCode: result.postalCode || undefined,
              city: result.city || undefined,
              state: result.state || undefined,
            },
            // Keys only when they changed: any key change needs a recent sign-in.
            ...(sshChanged ? { sshPublicKeys: result.sshKeys } : {}),
          },
        },
      });
      await throwIfSignInNeeded(res.clone());
      if (!res.ok) throw new Error(t().failedToUpdateDetails);
      window.location.reload();
    } catch (error) {
      setDetailsBusy(false);
      // A new SSH key needs a recent sign-in: sign in again and reopen the dialog with what was entered.
      if (error instanceof SignInNeededError && error.code === "REAUTHENTICATE") {
        setDetailsOpen(false);
        return confirmIdentity(
          t().sshKeyReauthenticate,
          DETAILS_INTENT,
          { title: t().confirmIdentity, confirm: t().confirmIdentity },
          result,
        );
      }
      setDetailsError(
        error instanceof SignInNeededError ? t().sshKeysInBrowser : error instanceof Error ? error.message : t().failedToUpdateDetails,
      );
    }
  };

  // ── Extend ──
  const [extending, setExtending] = createSignal(false);
  const [extended, setExtended] = createSignal<string | null>(null);
  const extend = async () => {
    if (extending()) return;
    setExtending(true);
    try {
      const res = await apiClient.me["account-extension"].$post();
      if (!res.ok) throw new Error(t().failedToExtendAccount);
      const result = await res.json();
      setExtended(
        result.newExpiry
          ? t().accountExtendedUntil({ date: dates.formatDate(result.newExpiry, { locale: locale() }) })
          : t().accountExtensionNotApplied,
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : t().failedToExtendAccount, { status: "bad" });
    } finally {
      setExtending(false);
    }
  };

  // Back from "Confirm identity": reopen the details dialog with what the person entered.
  onMount(() => {
    if (!isIpa || props.details === false) return;
    const returned = takeReturnIntent(DETAILS_INTENT);
    if (returned) editDetails(DetailsDraftSchema.safeParse(returned.draft).data);
  });

  const dialogs = (): JSX.Element => (
    <>
      <Dialog
        title={t().editProfile}
        open={profileOpen()}
        onOpenChange={(open) => !profileBusy() && setProfileOpen(open)}
        foot={
          <>
            <Button onClick={() => setProfileOpen(false)} disabled={profileBusy()}>
              {t().cancel}
            </Button>
            <Button variant="primary" onClick={() => void saveProfile()} busy={profileBusy()}>
              {t().save}
            </Button>
          </>
        }
      >
        <Notice tone="warn">{t().realNameNotice}</Notice>
        <Text muted>{t().identityVisibility({ holders: holders() })}</Text>
        <Field name="givenname" label={t().firstName} error={required(givenname())} required>
          <Input value={givenname()} onInput={setGivenname} placeholder={t().firstNamePlaceholder} />
        </Field>
        <Field name="sn" label={t().lastName} error={required(sn())} required>
          <Input value={sn()} onInput={setSn} placeholder={t().lastNamePlaceholder} />
        </Field>
        <Field name="displayName" label={t().displayName} error={required(displayName())} required>
          <Input value={displayName()} onInput={setDisplayName} placeholder={t().displayNamePlaceholder} />
        </Field>
        <Show when={profileError()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      </Dialog>

      <Dialog
        title={t().contactAndDetails}
        open={detailsOpen()}
        onOpenChange={(open) => !detailsBusy() && setDetailsOpen(open)}
        foot={
          <>
            <Button onClick={() => setDetailsOpen(false)} disabled={detailsBusy()}>
              {t().cancel}
            </Button>
            <Button variant="primary" onClick={() => void saveDetails()} busy={detailsBusy()}>
              {t().save}
            </Button>
          </>
        }
      >
        <Text muted>{t().detailVisibility({ holders: holders() })}</Text>
        <Field name="phone" label={t().phone} optional={t().optional}>
          <Input type="tel" icon="phone" value={phone()} onInput={setPhone} placeholder={t().phonePlaceholder} />
        </Field>
        <Show when={isIpa}>
          <Field name="street" label={t().street} optional={t().optional}>
            <Input value={street()} onInput={setStreet} placeholder={t().streetPlaceholder} />
          </Field>
          <Field.Row>
            <Field name="postalCode" label={t().postalCode} optional={t().optional}>
              <Input value={postalCode()} onInput={setPostalCode} placeholder={t().postalCodePlaceholder} />
            </Field>
            <Field name="city" label={t().city} optional={t().optional}>
              <Input value={city()} onInput={setCity} placeholder={t().cityPlaceholder} />
            </Field>
          </Field.Row>
          <Field name="state" label={t().state} optional={t().optional}>
            <Input value={state()} onInput={setState} placeholder={t().statePlaceholder} />
          </Field>
          <Notice tone="note" icon="terminal-2" title={t().sshKeys}>
            {t().connectVia} ssh {props.user.uid}@host-ip · {t().generateSshKey} ssh-keygen -t ed25519 · {t().pasteSshKey}{" "}
            ~/.ssh/id_ed25519.pub
          </Notice>
          <Show when={keys().length > 0}>
            <List label={t().sshKeys}>
              <For each={keys()}>
                {(key, index) => {
                  const info = keyLabel(key);
                  return (
                    <Row
                      icon="key"
                      lines={[info.comment || info.type, `${info.type} ${info.suffix}`]}
                      end={
                        <Button
                          variant="ghost"
                          icon="trash"
                          label={t().removeNamedSshKey({ name: info.comment || info.type })}
                          onClick={() => setKeys(keys().filter((_, position) => position !== index()))}
                        />
                      }
                    />
                  );
                }}
              </For>
            </List>
          </Show>
          <Field name="sshKey" label={t().addKey} error={keyError() ?? undefined}>
            <Input
              multiline
              value={newKey()}
              placeholder="ssh-ed25519 AAAA... your-comment"
              onInput={(value) => {
                setNewKey(value);
                setKeyError(null);
              }}
            />
          </Field>
          <Bar
            end={
              <Button icon="plus" onClick={addKey} label={t().addKey}>
                {t().addKey}
              </Button>
            }
          />
        </Show>
        <Show when={detailsError()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      </Dialog>

      <Dialog
        title={t().extendAccount}
        open={extended() !== null}
        onOpenChange={(open) => {
          if (!open) window.location.reload();
        }}
        foot={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t().close}
          </Button>
        }
      >
        <Text>{extended()}</Text>
      </Dialog>
    </>
  );

  return {
    changeAvatar: () => void changeAvatar(),
    editProfile: canMutateAccount ? editProfile : undefined,
    editDetails: isIpa ? () => editDetails() : undefined,
    extend: canMutateAccount ? () => void extend() : undefined,
    extending,
    dialogs,
  };
};
