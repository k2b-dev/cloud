import { Button, Checkbox, NoticeCard, NumberInput, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { z } from "zod";
import { artifactClient } from "./client";
import type { DatabaseSettings } from "./database-contracts";
import { artifactMessages } from "./messages";
import type { StorageSettings } from "./storage-settings";

type DatabaseView = Awaited<ReturnType<typeof artifactClient.admin.settings>>;
type StorageView = Awaited<ReturnType<typeof artifactClient.admin.storageSettings>>;

export function DatabaseSettingsForm(props: { current: DatabaseView; close: () => void }) {
  const locale = useLocale();
  const t = () => artifactMessages.resolve([locale()]).t;
  const [url, setUrl] = createSignal(props.current.url);
  const [token, setToken] = createSignal("");
  const [replace, setReplace] = createSignal<string[]>([]);
  const [unreadableKeys, setUnreadableKeys] = createSignal(props.current.unreadable);
  const [busy, setBusy] = createSignal(false);
  const [action, setAction] = createSignal<"test" | "save" | "clear" | null>(null);
  const [failure, setFailure] = createSignal("");
  const [tested, setTested] = createSignal(false);
  const keys = ["assistant.rsql_url", "assistant.rsql_api_token"] as const;
  const unreadable = (key: (typeof keys)[number]) => unreadableKeys()?.[key] === true;
  const input = (forTest = false): z.input<typeof DatabaseSettings> => ({
    ...((!unreadable(keys[0]) || replace().includes(keys[0])) && (forTest || url() !== props.current.url || replace().includes(keys[0]))
      ? { url: url() }
      : {}),
    ...((!unreadable(keys[1]) || replace().includes(keys[1])) && (token() || replace().includes(keys[1])) ? { token: token() } : {}),
    replaceUnreadable: keys.filter((key) => unreadable(key) && replace().includes(key)),
  });
  const act = async (test: boolean) => {
    if (busy()) return;
    setBusy(true);
    setAction(test ? "test" : "save");
    setFailure("");
    setTested(false);
    try {
      if (test) {
        await artifactClient.admin.test(input(true));
        setTested(true);
      } else {
        await artifactClient.admin.configure(input());
        props.close();
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().REQUEST_FAILED);
      if (error instanceof Error && "code" in error && error.code === "setting_unreadable") {
        try {
          setUnreadableKeys((await artifactClient.admin.settings()).unreadable);
        } catch {
          setFailure(`${error.message} ${t().recoveryFailed}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-4">
      <Show when={keys.some(unreadable)}>
        <NoticeCard tone="warning" title={t().unreadableTitle} detail={t().unreadableDetail}>
          <For each={keys.filter(unreadable)}>
            {(key) => (
              <Checkbox
                label={`${t().replaceStored}: ${key === keys[0] ? t().serverUrl : t().token}`}
                value={replace().includes(key)}
                disabled={busy()}
                onValueChange={(checked) => {
                  setReplace((items) => (checked ? [...items, key] : items.filter((item) => item !== key)));
                  setTested(false);
                }}
              />
            )}
          </For>
        </NoticeCard>
      </Show>
      <TextInput
        label={t().serverUrl}
        value={url()}
        disabled={busy() || (unreadable(keys[0]) && !replace().includes(keys[0]))}
        onValueChange={(value) => {
          setUrl(value);
          setTested(false);
        }}
      />
      <TextInput
        label={t().token}
        password
        value={token()}
        placeholder={props.current.tokenSet ? "••••••••" : ""}
        disabled={busy() || (unreadable(keys[1]) && !replace().includes(keys[1]))}
        onValueChange={(value) => {
          setToken(value);
          setTested(false);
        }}
      />
      <p class="text-sm text-muted">{t().tokenHint}</p>
      <Show when={failure()}>
        <NoticeCard tone="danger" title={failure()} />
      </Show>
      <Show when={tested()}>
        <NoticeCard tone="success" title={t().connectionReady} />
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button variant="secondary" loading={busy() && action() === "test"} disabled={busy()} onClick={() => act(true)}>
          {t().testConnection}
        </Button>
        <Button loading={busy() && action() === "save"} disabled={busy()} onClick={() => act(false)}>
          {t().save}
        </Button>
        <Show when={props.current.url || props.current.tokenSet || keys.some(unreadable)}>
          <Button
            variant="subtle"
            loading={busy() && action() === "clear"}
            disabled={busy() || keys.some((key) => unreadable(key) && !replace().includes(key))}
            onClick={async () => {
              if (busy()) return;
              setBusy(true);
              setAction("clear");
              setFailure("");
              try {
                await artifactClient.admin.configure({ url: "", token: "", replaceUnreadable: keys.filter(unreadable) });
                props.close();
              } catch (error) {
                setFailure(error instanceof Error ? error.message : t().REQUEST_FAILED);
                if (error instanceof Error && "code" in error && error.code === "setting_unreadable") {
                  try {
                    setUnreadableKeys((await artifactClient.admin.settings()).unreadable);
                  } catch {
                    setFailure(`${error.message} ${t().recoveryFailed}`);
                  }
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {t().clearSettings}
          </Button>
        </Show>
      </div>
    </div>
  );
}

export function StorageSettingsForm(props: { current: StorageView; close: () => void }) {
  const locale = useLocale();
  const t = () => artifactMessages.resolve([locale()]).t;
  const [file, setFile] = createSignal<number | null>(props.current.fileMiB);
  const [total, setTotal] = createSignal<number | null>(props.current.totalMiB);
  const [replace, setReplace] = createSignal<string[]>([]);
  const [unreadableKeys, setUnreadableKeys] = createSignal(props.current.unreadable);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const keys = ["assistant.storage_file_mib", "assistant.storage_total_mib"] as const;
  const label = (key: (typeof keys)[number]) => (key === keys[0] ? t().storageFileLimit : t().storageTotalLimit);
  const unreadable = (key: (typeof keys)[number]) => unreadableKeys()[key];
  const locked = (key: (typeof keys)[number]) => unreadable(key) && !replace().includes(key);
  const valid = () => file() !== null && total() !== null && file()! >= 1 && file()! <= 64 && total()! >= 1 && total()! <= 1048576;
  const save = async () => {
    if (!valid() || busy()) return;
    setBusy(true);
    setFailure("");
    const input: z.input<typeof StorageSettings> = {
      ...(!locked(keys[0]) && (file() !== props.current.fileMiB || replace().includes(keys[0])) ? { fileMiB: file()! } : {}),
      ...(!locked(keys[1]) && (total() !== props.current.totalMiB || replace().includes(keys[1])) ? { totalMiB: total()! } : {}),
      replaceUnreadable: keys.filter((key) => unreadable(key) && replace().includes(key)),
    };
    try {
      await artifactClient.admin.configureStorage(input);
      props.close();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().REQUEST_FAILED);
      if (error instanceof Error && "code" in error && error.code === "setting_unreadable") {
        try {
          setUnreadableKeys((await artifactClient.admin.storageSettings()).unreadable);
        } catch {
          setFailure(`${error.message} ${t().recoveryFailed}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Show when={keys.some(unreadable)}>
        <NoticeCard tone="warning" title={t().unreadableTitle} detail={t().unreadableDetail}>
          <For each={keys.filter(unreadable)}>
            {(key) => (
              <Checkbox
                label={`${t().replaceStored}: ${label(key)}`}
                value={replace().includes(key)}
                disabled={busy()}
                onValueChange={(checked) => setReplace((items) => (checked ? [...items, key] : items.filter((item) => item !== key)))}
              />
            )}
          </For>
        </NoticeCard>
      </Show>
      <NumberInput
        label={label(keys[0])}
        value={file()}
        onValueChange={setFile}
        min={1}
        max={64}
        disabled={busy() || locked(keys[0])}
        required
      />
      <NumberInput
        label={label(keys[1])}
        value={total()}
        onValueChange={setTotal}
        min={1}
        max={1048576}
        disabled={busy() || locked(keys[1])}
        required
      />
      <Show when={failure()}>
        <NoticeCard tone="danger" title={failure()} />
      </Show>
      <Button type="submit" disabled={busy() || !valid()} loading={busy()}>
        {t().save}
      </Button>
    </form>
  );
}
