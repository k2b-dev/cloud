import { useLocale } from "@k2b/ui";
import {
  Button,
  Canvas,
  Check,
  Chip,
  confirm,
  Dialog,
  Empty,
  Facts,
  Failed,
  Field,
  Input,
  List,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  type Person,
  Row,
  Section,
  Text,
} from "@k2b/ui/v2";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { cloudAvatarImage } from "../account/Avatar";
import type { Principal } from "../contracts/shared";
import type { AccessDialogProps, FoundServiceAccount } from "./AccessDialog";
import { type AccessMark, createAccessDialogState, isApiKeyAccount, isCodeAccount } from "./access-dialog-state";
import type { DraftRow } from "./access-draft";
import { removeRow, restoreRow } from "./access-draft";
import { levelKey } from "./PermissionEditor";
import { principalKey } from "./principal-key";
import { type PrincipalSearchEntry, searchPrincipals } from "./principal-search";

/** How long typing pauses before the directory is asked, as in v1's combobox. */
const SEARCH_DEBOUNCE_MS = 200;

const chip = (mark: AccessMark | null) =>
  mark &&
  (mark.tone === "ok" ? (
    <Chip status="ok">{mark.label}</Chip>
  ) : mark.tone === "bad" ? (
    <Chip status="bad">{mark.label}</Chip>
  ) : (
    <Chip status="warn">{mark.label}</Chip>
  ));

const changeIcon = { add: "plus", remove: "minus", change: "arrows-exchange", neutral: "building", warning: "world" } as const;

/**
 * The access dialog on v2: who may use one resource as rows, General as switches, service accounts by their handle,
 * and "What changes" before Save. The same draft, rules, questions and saving as the v1 dialog
 * (`createAccessDialogState`); only the look follows the page.
 */
export function AccessDialogV2(props: AccessDialogProps & { close: (saved: boolean) => void }) {
  const locale = useLocale();
  const [open, setOpen] = createSignal(true);
  const finish = (saved: boolean) => {
    setOpen(false);
    props.close(saved);
  };
  const state = createAccessDialogState(
    props,
    locale,
    (question) => confirm({ title: question.title, description: question.body, confirm: question.confirm, cancel: question.cancel }),
    finish,
  );
  const t = state.t;
  const access = state.access;
  const editable = () => state.canEdit() && !state.saving();
  const [summaryOpen, setSummaryOpen] = createSignal(true);

  // ── Search ────────────────────────────────────────────────────────────
  // k2b-ui gap: v2 has no single-choice lookup (pick one to add). The search is a field with its results as rows below
  // it; each row adds its principal, and one already listed says its level instead.
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<PrincipalSearchEntry[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchFailed, setSearchFailed] = createSignal(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchAbort: AbortController | undefined;
  onCleanup(() => {
    clearTimeout(searchTimer);
    searchAbort?.abort();
  });
  const listed = () => state.rows().filter((row) => row.next);
  const search = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer);
    searchAbort?.abort();
    setSearchFailed(false);
    if (value.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    searchTimer = setTimeout(() => {
      const controller = new AbortController();
      searchAbort = controller;
      setSearching(true);
      void searchPrincipals(
        value,
        {
          existing: listed().map((row) => row.principal),
          target: props.target,
          allowAuthenticated: false,
          allowPublic: false,
          allowServiceAccounts: props.allowAgents !== false,
          serviceAccountKinds: ["agent", "standalone"],
          serviceAccountStatus: "active",
          takenReason: () => "",
          findServiceAccount:
            state.findServiceAccount() &&
            (async (handle, signal) => {
              const account = await state.findServiceAccount()!(handle, signal);
              if (account?.description && account.principal.type === "service_account")
                state.foundDescriptions.set(account.principal.serviceAccountId, account.description);
              return account && { ...account, description: t().serviceAccountJoins({ kind: account.description ?? t().serviceAccount }) };
            }),
        },
        controller.signal,
        locale(),
      )
        .then((entries) => {
          if (!controller.signal.aborted) setResults(entries);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearchFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
  };
  const listedRow = (principal: Principal) => listed().find((row) => principalKey(row.principal) === principalKey(principal));
  const add = (entry: PrincipalSearchEntry) => {
    state.addSelected(entry.principal, {
      displayName: entry.label,
      avatarHash: entry.avatarHash,
      serviceAccountKind: entry.serviceAccountKind,
    });
    search("");
  };

  // ── Rows ──────────────────────────────────────────────────────────────
  const person = (row: DraftRow): Person => {
    const kind = row.principal.type === "service_account" ? "service_account" : "user";
    const id =
      row.principal.type === "user"
        ? row.principal.userId
        : row.principal.type === "service_account"
          ? row.principal.serviceAccountId
          : undefined;
    const image = row.principal.type === "group" ? undefined : cloudAvatarImage({ kind, userId: id, avatarHash: row.display.avatarHash });
    return { name: state.nameOf(row), ...(image ? { image } : {}) };
  };
  // k2b-ui gap: a Menu choice option has no description line; a level's meaning shows only as the reason of a lock.
  const levelMenu = (row: DraftRow): MenuEntry[] => {
    const protectedRow = state.lastManagers().has(row.key);
    const current = row.next ? levelKey(row.next.permission, row.next.scope) : "";
    return [
      {
        title: t().levelFor({ name: state.nameOf(row) }),
        choice: current,
        onChoose: (key: string) => state.chooseLevel(row, key),
        items: state.levelOptions(row).map((option) => ({
          value: option.key,
          label: option.label,
          disabled: option.disabled,
          meta: option.disabled ? option.description : undefined,
        })),
      },
      {
        label: t().removeEntry,
        icon: "x",
        danger: true,
        disabled: protectedRow,
        onClick: () => state.edit((draft) => removeRow(draft, row)),
      },
    ];
  };
  const AccessRowV2 = (rowProps: { row: DraftRow }): JSX.Element => {
    const row = () => rowProps.row;
    return (
      <Row
        avatar={person(row())}
        lines={[state.nameOf(row()), state.kindLine(row()) || " "]}
        meta={state.isViewer(row()) ? t().you : undefined}
        href={row().display.serviceAccountHref}
        end={
          <>
            {chip(state.mark(row()))}
            <Show
              when={row().next && state.canEdit()}
              fallback={
                <Show
                  when={!row().next && state.canEdit()}
                  fallback={
                    <Show when={!isCodeAccount(row().display.serviceAccountKind)}>
                      <Text type="meta">{state.levelLabel(row().principal, row().next)}</Text>
                    </Show>
                  }
                >
                  {/* Undo takes the place of the level, so the row keeps its size. */}
                  <Button
                    variant="text"
                    disabled={!editable() || !state.canRestore(row())}
                    onClick={() => state.edit((draft) => restoreRow(draft, row()))}
                  >
                    {t().undo}
                  </Button>
                </Show>
              }
            >
              {/* A stored denial is shown, never offered: it can only be removed. */}
              <Show
                when={row().next?.permission !== "none"}
                fallback={<Text type="meta">{state.levelLabel(row().principal, row().next)}</Text>}
              >
                <Menu label={state.levelLabel(row().principal, row().next)} variant="ghost" disabled={!editable()} items={levelMenu(row())}>
                  {state.levelLabel(row().principal, row().next)}
                </Menu>
              </Show>
            </Show>
          </>
        }
      />
    );
  };

  // ── General ───────────────────────────────────────────────────────────
  const generalRow = (type: "authenticated" | "public") => {
    const label = type === "public" ? t().publicLabel : t().signedInLabel;
    const row = () => state.generalRow(type);
    return (
      <Row
        icon={type === "public" ? "world" : "building"}
        lines={[label, state.loading() ? " " : state.generalDescription(type)]}
        end={
          <>
            {chip(state.generalMark(type))}
            <Show when={state.generalOn(type) && type === "authenticated" && state.canEdit() && row()}>
              {(current) => (
                <Menu
                  label={state.levelLabel(current().principal, current().next)}
                  variant="ghost"
                  disabled={!editable()}
                  items={levelMenu(current()).slice(0, 1)}
                >
                  {state.levelLabel(current().principal, current().next)}
                </Menu>
              )}
            </Show>
            <Show
              when={state.canEdit()}
              fallback={<Text type="meta">{state.generalOn(type) ? state.levelLabel({ type }, row()?.next ?? null) : t().off}</Text>}
            >
              <Check
                switch
                label={label}
                checked={state.generalOn(type)}
                disabled={!editable() || state.loading() || Boolean(row() && state.lastManagers().has(row()!.key))}
                onChange={(value) => state.toggleGeneral(type, value)}
              />
            </Show>
          </>
        }
      />
    );
  };

  // ── Service accounts by handle ────────────────────────────────────
  const [handleOpen, setHandleOpen] = createSignal(false);
  const [handle, setHandle] = createSignal("");
  const [handleState, setHandleState] = createSignal<"idle" | "searching" | "missing" | "failed">("idle");
  const [found, setFound] = createSignal<FoundServiceAccount | null>(null);
  let handleAbort: AbortController | undefined;
  onCleanup(() => handleAbort?.abort());
  const lookUp = async () => {
    const find = state.findServiceAccount();
    const value = handle().trim();
    if (!find || !value) return;
    handleAbort?.abort();
    const controller = new AbortController();
    handleAbort = controller;
    setHandleState("searching");
    setFound(null);
    try {
      const account = await find(value, controller.signal);
      if (controller.signal.aborted) return;
      setFound(account);
      setHandleState(account ? "idle" : "missing");
    } catch {
      if (!controller.signal.aborted) setHandleState("failed");
    }
  };

  const foot = (): JSX.Element => (
    <Show when={state.canEdit()} fallback={<Button onClick={() => void state.dismiss()}>{t().close}</Button>}>
      <Button disabled={state.saving()} onClick={() => void state.dismiss()}>
        {t().cancel}
      </Button>
      <Button variant="primary" busy={state.saving()} disabled={state.changes().length === 0} onClick={() => void state.save()}>
        {state.changes().length > 0 ? `${t().save} · ${t().changeCount({ count: state.changes().length })}` : t().save}
      </Button>
    </Show>
  );

  return (
    <Dialog
      title={t().title({ name: props.resourceName })}
      open={open()}
      // Escape, the close button and the foot's Cancel ask before staged changes are dropped.
      onOpenChange={(next) => {
        if (!next) void state.dismiss();
      }}
      dismissible={state.changes().length === 0}
      foot={foot()}
    >
      <Show when={props.subtitle}>{(subtitle) => <Text muted>{subtitle()}</Text>}</Show>
      <Show when={!state.canEdit() && !state.loading()}>
        <Notice tone="note">{state.readOnlyLine()}</Notice>
      </Show>

      <Show when={state.canEdit() && !state.loading()}>
        <Input
          type="search"
          icon="search"
          label={t().search}
          placeholder={t().search}
          value={query()}
          disabled={state.saving()}
          onInput={search}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query()) {
              event.preventDefault();
              search("");
            }
          }}
        />
        <Show when={query().trim().length >= 2}>
          <Show when={!searchFailed()} fallback={<Failed text={access().retry} onRetry={() => search(query())} />}>
            <Show
              when={results().length > 0 || searching()}
              fallback={<Empty icon="search-off" text={`${t().nobodyNamed({ query: query().trim() })} ${t().searchHint}`} />}
            >
              <Show when={!searching() || results().length > 0} fallback={<Loading rows={3} lines={2} />}>
                <List label={t().search}>
                  <For each={results()}>
                    {(entry) => {
                      const already = () => listedRow(entry.principal);
                      return (
                        <Row
                          icon={entry.icon.replace(/^ti\s+ti-/, "")}
                          lines={entry.description ? [entry.label, entry.description] : [entry.label]}
                          meta={
                            already() ? t().alreadyHas({ level: state.levelLabel(already()!.principal, already()!.next) }) : entry.badge
                          }
                          action={already() ? undefined : { label: t().add, icon: "plus", onClick: () => add(entry) }}
                        />
                      );
                    }}
                  </For>
                </List>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>

      <Section icon="users" title={t().people} count={state.loading() ? undefined : state.peopleRows().filter((row) => row.next).length}>
        <Show
          when={state.loadState() === "ready"}
          fallback={
            <Show when={state.loadState() === "failed"} fallback={<Loading rows={4} lines={2} />}>
              <Failed text={t().loadFailed} onRetry={() => void state.load()} />
            </Show>
          }
        >
          <Show when={state.peopleRows().length > 0} fallback={<Text muted>{t().nobodyListed}</Text>}>
            {/* Rows are keyed by principal, so a staged change keeps the row, its controls and the focus. */}
            <For each={state.peopleRows().map((row) => row.key)}>
              {(key) => <Show when={state.rows().find((row) => row.key === key)}>{(row) => <AccessRowV2 row={row()} />}</Show>}
            </For>
          </Show>
        </Show>
      </Section>

      <Show when={state.loadState() !== "failed" && state.showGeneral()}>
        <Section icon="world" title={t().general}>
          <Show when={props.allowAuthenticated !== false || state.generalRow("authenticated")}>{generalRow("authenticated")}</Show>
          <Show when={props.allowPublic === true || state.generalRow("public")}>
            {generalRow("public")}
            <Show when={state.generalOn("public")}>
              <Notice tone="warn">{props.publicWarning ?? t().publicWarning}</Notice>
              <Show when={props.publicLink}>
                {(link) => <Facts items={[{ label: access().anyoneWithLink, value: link(), mono: true, copy: link() }]} />}
              </Show>
            </Show>
          </Show>
        </Section>
      </Show>

      <Show when={!state.loading() && state.showObjectAccounts()}>
        <Section
          icon="code"
          title={t().serviceAccounts}
          count={state.objectAccountRows().filter((row) => row.next).length}
          summary={state.objectAccountRows().length > 0 ? t().serviceAccountNote({ name: props.resourceName }) : t().serviceAccountsEmpty}
          actions={
            state.canAddObjectAccounts() && !handleOpen()
              ? [{ label: t().addServiceAccount, icon: "plus", disabled: state.saving(), onClick: () => setHandleOpen(true) }]
              : undefined
          }
        >
          <For each={state.objectAccountRows().map((row) => row.key)}>
            {(key) => <Show when={state.rows().find((row) => row.key === key)}>{(row) => <AccessRowV2 row={row()} />}</Show>}
          </For>
          <Show when={handleOpen()}>
            <Field
              label={t().serviceAccountHandle}
              name="service-account-handle"
              hint={
                handleState() === "searching"
                  ? t().serviceAccountSearching
                  : handleState() === "missing"
                    ? undefined
                    : t().serviceAccountHandlePlaceholder
              }
              error={
                handleState() === "missing"
                  ? t().serviceAccountNotFound
                  : handleState() === "failed"
                    ? t().serviceAccountLookupFailed
                    : undefined
              }
            >
              <Input
                value={handle()}
                placeholder="code-7k2q9m4xwt"
                disabled={state.saving()}
                onInput={(value) => {
                  setHandle(value);
                  setHandleState("idle");
                  setFound(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing) void lookUp();
                  if (event.key === "Escape") setHandleOpen(false);
                }}
                end={
                  <Button
                    variant="ghost"
                    icon="search"
                    label={t().serviceAccountHandle}
                    busy={handleState() === "searching"}
                    onClick={() => void lookUp()}
                  />
                }
              />
            </Field>
            <Show when={found()}>
              {(account) => (
                <Row
                  icon="code"
                  lines={[account().display.displayName, account().description ?? t().serviceAccount]}
                  action={{
                    label: t().addServiceAccount,
                    icon: "plus",
                    onClick: () => {
                      state.addFound(account());
                      setHandleOpen(false);
                      setHandle("");
                      setFound(null);
                    },
                  }}
                />
              )}
            </Show>
          </Show>
        </Section>
      </Show>

      <Show when={!state.loading() && state.apiKeyRows().length > 0}>
        <Section icon="key" title={t().apiKeys} count={state.apiKeyRows().filter((row) => row.next).length}>
          <For each={state.apiKeyRows().map((row) => row.key)}>
            {(key) => <Show when={state.rows().find((row) => row.key === key)}>{(row) => <AccessRowV2 row={row()} />}</Show>}
          </For>
        </Section>
      </Show>

      <Show when={props.extraSections}>
        {/* The app's further section (such as its v1 API keys) keeps its own drawing until it has a v2 form. */}
        <Canvas label={t().apiKeys}>{props.extraSections}</Canvas>
      </Show>

      <Show when={state.changes().length > 0}>
        <Section
          icon="list-check"
          title={t().whatChanges}
          count={state.changes().length}
          actions={[{ label: summaryOpen() ? t().hideChanges : t().showChanges, onClick: () => setSummaryOpen((value) => !value) }]}
        >
          <For each={summaryOpen() ? state.changeItems() : []}>
            {(item) => (
              <Row
                icon={changeIcon[item.tone]}
                lines={item.detail ? [`${item.name}${item.text}`, item.detail] : [`${item.name}${item.text}`]}
              />
            )}
          </For>
        </Section>
      </Show>
      <Show when={state.failed()}>
        <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void state.save() }]}>
          {t().saveFailed({ count: state.changes().length })}
        </Notice>
      </Show>
    </Dialog>
  );
}
