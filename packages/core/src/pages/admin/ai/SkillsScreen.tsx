import type { AiAppSkillIssue } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import {
  Bar,
  Button,
  Canvas,
  Chip,
  Dialog,
  Empty,
  Facts,
  Failed,
  Icon,
  Inline,
  List,
  Loading,
  Mark,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Path,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";
import { diffSkillVersions } from "../settings/_components/skill-diff";
import { openSkillAccess, readError } from "./content-access";
import type { AiSkillRow, AiSkillsData } from "./content-data";
import { aiContentMessages } from "./content-messages";
import { type ContentAddress, ContentPager, ContentSearch, contentHref } from "./content-parts";
import { AI_COLOR, aiAreaLink, aiSectionLabel } from "./frame";
import SkillDiff from "./SkillDiff";

const skillMark = { icon: "wand", color: AI_COLOR };

/**
 * Skills on v2: the shared Skills of the platform as a table with search and pages, the open Skill beside it with its
 * facts and deeds (permissions, comparison with the app's version, delete), and the app Skills Cloud does not offer
 * with their way back. Search, page and the open Skill live in the address.
 */
export default function SkillsScreen(props: { nav: NavProps; data: AiSkillsData }) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const t = () => aiContentMessages.resolve([locale()]).t;
  const toast = useToast();
  const data = () => props.data;
  const address = (): ContentAddress => ({ sec: "skills", search: data().search, page: data().page, open: data().open });
  const pages = () => Math.max(1, Math.ceil(data().total / data().perPage));
  const open = () => data().skills.find((skill) => skill.shortId === data().open);
  const appName = (source: { appId: string; appName: string }) => data().appNames[source.appId] ?? source.appName;
  const sourceApp = (skill: AiSkillRow) => (skill.source ? appName(skill.source) : "");
  const listHref = () => contentHref({ ...address(), open: null });
  const reload = () => navigateTo(window.location.pathname + window.location.search);

  // A loading access list shows on its button; leaving the page drops the answer instead of opening a dialog over it.
  const loading = new AbortController();
  onCleanup(() => loading.abort());
  const [accessBusy, setAccessBusy] = createSignal(false);
  const editAccess = async (skill: AiSkillRow) => {
    if (accessBusy()) return;
    setAccessBusy(true);
    try {
      if (await openSkillAccess(skill, locale(), loading.signal)) reload();
    } catch (error) {
      if (!loading.signal.aborted) toast(error instanceof Error ? error.message : s().loadSkillPermissionsFailed, { status: "bad" });
    } finally {
      setAccessBusy(false);
    }
  };
  const [deleting, setDeleting] = createSignal(false);
  const remove = async (skill: AiSkillRow) => {
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    const agreed = await Dialog.confirm({
      title: s().deleteSkill,
      description: skill.source
        ? s().deleteAppSkillConfirm({ name: skill.name, app: appName(skill.source) })
        : s().deleteSkillConfirm({ name: skill.name }),
      confirm: s().delete,
    });
    if (!agreed) return;
    setDeleting(true);
    const response = await coreClient.admin.core["ai-skills"][":skillId"].$delete({ param: { skillId: skill.shortId } }).catch(() => null);
    if (response?.ok) return navigateTo(listHref());
    setDeleting(false);
    toast(response ? await readError(response, s().deleteSkillFailed) : s().deleteSkillFailed, { status: "bad" });
  };
  const [comparing, setComparing] = createSignal<AiSkillRow | null>(null);

  const sourceText = (skill: AiSkillRow) => (skill.source ? s().fromApp({ app: appName(skill.source) }) : s().customSkill);
  /**
   * Where a Skill comes from, for an app's Skill only (a Skill of its own needs no word in every row): the app and its
   * state. Current and customized are quiet; an update of the app is the one state that asks for a look.
   */
  const sourceCell = (skill: AiSkillRow) => {
    const source = skill.source;
    if (!source) return "";
    const quiet = [appName(source), source.status === "modified" ? s().appSkillCustomized : "", source.available ? "" : s().appSkillUnavailable]
      .filter(Boolean)
      .join(" · ");
    return source.status === "update_available" ? (
      <>
        {quiet} ·{" "}
        <Text tone="warn" weight="medium">
          <Icon name="point-filled" /> {s().appSkillUpdate}
        </Text>
      </>
    ) : (
      quiet
    );
  };
  /** No admin is a problem only for a Skill of its own; an app's Skill is managed by the app. */
  const orphan = (skill: AiSkillRow) => skill.adminCount === 0 && !skill.source;
  const adminsText = (skill: AiSkillRow) =>
    skill.adminCount === 0 ? (skill.source ? s().managedByApp : s().noAdmins) : t().admins({ count: skill.adminCount });
  const adminsCell = (skill: AiSkillRow) =>
    orphan(skill) ? (
      <Text tone="bad" weight="medium">
        <Icon name="point-filled" /> {s().noAdmins}
      </Text>
    ) : (
      <Text muted={skill.adminCount === 0}>{adminsText(skill)}</Text>
    );

  /** The list; beside an open entry it keeps its width and a grip, alone it takes the page (no empty half). */
  const listPane = (split: boolean) => (
        <Pane
          label={t().skillsList}
          width={split ? { min: 420, default: 600 } : undefined}
          scrollKey="admin-ai-skills"
          status={
            // k2b-ui gap: Hero figure (#4360); the summary's count is the statement until the figure type exists
            <StatusRow
              lead={data().search ? t().matches({ count: data().summary.total, search: data().search }) : t().skillsLead({ count: data().summary.total })}
              facts={[
                { value: data().summary.totalAccess.toLocaleString(locale()), after: t().accessAfter },
                ...(pages() > 1 ? [{ value: t().pageOf({ page: data().page, pages: pages() }) }] : []),
              ]}
              filters={<ContentPager address={address()} pages={pages()} t={t()} />}
            />
          }
        >
          <Show when={data().summary.unmanaged > 0}>
            <Notice tone="bad" title={t().skillsUnmanaged({ count: data().summary.unmanaged })}>
              {t().unmanagedText}
            </Notice>
          </Show>
          <Table
            label={t().skillsList}
            rows={data().skills}
            rowKey={(skill) => skill.shortId}
            current={data().open ?? undefined}
            open={(skill) => ({ href: contentHref({ ...address(), open: skill.shortId }) })}
            empty={
              data().search
                ? {
                    icon: "filter-off",
                    text: s().noSkillsMatch({ search: data().search }),
                    action: { label: t().showAll, href: contentHref({ sec: "skills", search: "", page: 1 }) },
                  }
                : { icon: "wand", text: s().noSkills }
            }
            phone={(skill) => ({
              mark: skillMark,
              lines: [
                skill.name,
                <>
                  <Show when={orphan(skill)} fallback={adminsText(skill)}>
                    <Text tone="bad">
                      <Icon name="point-filled" /> {s().noAdmins}
                    </Text>
                  </Show>
                  {skill.source ? ` · ${appName(skill.source)}` : ""}
                </>,
              ],
              time: skill.updated,
            })}
            columns={[
              { title: s().skill, width: { min: 180, default: 260 }, mark: () => skillMark, cell: (skill) => skill.name },
              // the one problem column stands right after the name, so it stays in view beside an open Skill
              { title: s().admins, width: { min: 140, default: 180 }, cell: adminsCell },
              { title: s().access, width: { min: 72, default: 84 }, align: "end", cell: (skill) => skill.accessCount.toLocaleString(locale()) },
              { title: s().skillSource, width: { min: 140, default: 260 }, drop: true, cell: sourceCell },
              { title: s().updated, drop: true, cell: (skill) => skill.updated },
            ]}
          />
          <Show when={data().appSkillIssues.length > 0}>
            <AppSkillIssues issues={data().appSkillIssues} appName={appName} reload={reload} />
          </Show>
        </Pane>
  );
  /** The open entry beside the list; on the phone it is the page, with the way back to the list. */
  const detailPane = (skill: AiSkillRow) => (
            <Pane
              detail
              label={skill.name}
              back={{ label: t().skillsList, href: listHref() }}
              head={
                <Bar
                  start={
                    // k2b-ui gap: tinted object head (ObjectHead, #4360); mark and name stand in
                    <Inline>
                      <Mark {...skillMark} />
                      <Text type="body" weight="strong">
                        {skill.name}
                      </Text>
                    </Inline>
                  }
                  end={
                    <>
                      <Button icon="shield" busy={accessBusy()} onClick={() => void editAccess(skill)}>
                        {s().permissions}
                      </Button>
                      <Menu
                        label={s().actionsFor({ name: skill.name })}
                        disabled={deleting()}
                        items={[
                          ...(skill.source ? [{ label: s().compareWithApp, icon: "git-compare", onClick: () => setComparing(skill) }] : []),
                          { label: s().deleteSkill, icon: "trash", danger: true, onClick: () => void remove(skill) },
                        ]}
                      />
                      <Button variant="ghost" icon="x" label={t().closeDetail} href={listHref()} />
                    </>
                  }
                />
              }
            >
              <Show when={orphan(skill)}>
                <Notice
                  tone="bad"
                  title={t().noAdminTitle}
                >
                  {t().skillNoAdminText}
                </Notice>
              </Show>
              <Show when={skill.source?.status === "update_available"}>
                <Notice
                  tone="warn"
                  title={s().appSkillUpdate}
                  actions={[{ label: s().compareWithApp, icon: "git-compare", onClick: () => setComparing(skill) }]}
                >
                  {t().updateText}
                </Notice>
              </Show>
              <Show when={skill.description}>
                <Text>{skill.description}</Text>
              </Show>
              <Section icon="info-circle" title={t().details}>
                <Facts
                  items={[
                    { label: s().skillSource, value: sourceText(skill) },
                    // an update stands as the notice above; the fact says only a quieter state
                    ...(skill.source && skill.source.status !== "update_available"
                      ? [
                          {
                            label: t().state,
                            value: skill.source?.status === "modified" ? s().appSkillCustomized : s().appSkillCurrent,
                            hint: skill.source?.available ? undefined : s().appSkillUnavailable,
                          },
                        ]
                      : []),
                    { label: s().access, value: t().entries({ count: skill.accessCount }) },
                    // no admin stands as the notice above; the fact says it only once
                    ...(orphan(skill) ? [] : [{ label: s().admins, value: adminsText(skill) }]),
                    { label: t().references, value: skill.referenceCount.toLocaleString(locale()) },
                    { label: s().updated, value: skill.updated },
                    { label: t().created, value: skill.created },
                    { label: t().id, value: skill.shortId, mono: true, copy: skill.shortId },
                  ]}
                />
              </Section>
            </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while a Skill is open: no empty half (identity rule 5)
      detail={open() ? 440 : undefined}
      head={
        <Bar
          start={<Path label={aiAreaLink(locale()).label} items={[aiAreaLink(locale()), { label: aiSectionLabel(locale(), "skills") }]} />}
          end={<ContentSearch address={address()} label={s().searchAiSkills} placeholder={t().searchPlaceholder} />}
        />
      }
    >
      <Show when={open()} fallback={listPane(false)}>
        {(skill) => (
          <Pane.Split>
            {listPane(true)}
            {detailPane(skill())}
          </Pane.Split>
        )}
      </Show>
      <Show when={comparing()}>
        {(skill) => (
          <AppVersionDialog
            skill={skill()}
            appName={sourceApp(skill())}
            onClose={() => setComparing(null)}
            onReset={reload}
          />
        )}
      </Show>
    </AdminWorkspace>
  );
}

/** The app Skills Cloud does not install again on its own, each with the way back where one exists. */
function AppSkillIssues(props: { issues: AiAppSkillIssue[]; appName: (issue: AiAppSkillIssue) => string; reload: () => void }) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const t = () => aiContentMessages.resolve([locale()]).t;
  const toast = useToast();
  const [busy, setBusy] = createSignal<string | null>(null);
  const run = async (issue: AiAppSkillIssue, action: "restore" | "adopt") => {
    const label = action === "adopt" ? s().adoptAppSkill : issue.state === "deleted" ? s().restoreAppSkill : s().installAppSkill;
    const agreed = await Dialog.confirm({
      title: label,
      description:
        action === "adopt"
          ? s().adoptAppSkillConfirm({ name: issue.name, app: props.appName(issue) })
          : s().restoreAppSkillConfirm({ name: issue.name, app: props.appName(issue) }),
      confirm: label,
    });
    if (!agreed) return;
    setBusy(`${issue.appId}/${issue.name}`);
    const route = coreClient.admin.core["ai-skills"].apps[":appId"].skills[":name"];
    const request = { param: { appId: issue.appId, name: issue.name }, json: { confirmed: true as const } };
    const response = await (action === "adopt" ? route.adopt.$post(request) : route.restore.$post(request)).catch(() => null);
    if (response?.ok) return props.reload();
    setBusy(null);
    toast(response ? await readError(response, s().appSkillActionFailed) : s().appSkillActionFailed, { status: "bad" });
  };
  const stateChip = (issue: AiAppSkillIssue) =>
    issue.state === "invalid" ? (
      <Chip status="bad">{s().appSkillInvalid}</Chip>
    ) : issue.state === "name_taken" ? (
      <Chip status="warn">{s().appSkillNameTaken}</Chip>
    ) : (
      <Chip>{s().appSkillDeleted}</Chip>
    );
  return (
    <Section icon="plug-x" title={s().appSkillsNotInstalled} count={t().issuesCount({ count: props.issues.length })} summary={s().appSkillsNotInstalledDescription}>
      <List label={s().appSkillsNotInstalled}>
        <For each={props.issues}>
          {(issue) => (
            <Row
              mark={{ icon: "wand" }}
              lines={[
                issue.name,
                [
                  s().fromApp({ app: props.appName(issue) }),
                  issue.state === "invalid" ? s().appSkillInvalidHelp : "",
                  issue.available ? "" : s().appSkillUnavailable,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ]}
              states={stateChip(issue)}
              end={
                issue.state === "invalid" ? undefined : (
                  <Menu
                    label={s().appSkillActions({ name: issue.name })}
                    disabled={busy() === `${issue.appId}/${issue.name}`}
                    items={[
                      {
                        label: issue.state === "deleted" ? s().restoreAppSkill : s().installAppSkill,
                        icon: "restore",
                        onClick: () => void run(issue, "restore"),
                      },
                      ...(issue.state === "name_taken" ? [{ label: s().adoptAppSkill, icon: "link", onClick: () => void run(issue, "adopt") }] : []),
                    ]}
                  />
                )
              }
            />
          )}
        </For>
      </List>
    </Section>
  );
}

/** The Skill beside its app's version: the differences per file, and the way back to the app's version. */
function AppVersionDialog(props: { skill: AiSkillRow; appName: string; onClose: () => void; onReset: () => void }) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const t = () => aiContentMessages.resolve([locale()]).t;
  const toast = useToast();
  const version = query.create({
    source: () => props.skill.shortId,
    load: async (skillId, { abortSignal }) => {
      const response = await coreClient.admin.core["ai-skills"][":skillId"]["app-version"].$get(
        { param: { skillId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readError(response, s().appVersionFailed));
      return response.json();
    },
  });
  const files = createMemo(() => {
    const answer = version.data();
    return answer?.app ? diffSkillVersions(answer.current, answer.app) : [];
  });
  const [resetting, setResetting] = createSignal(false);
  const reset = async () => {
    const appVersion = version.data()?.appVersion;
    if (!appVersion) return;
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    const agreed = await Dialog.confirm({
      title: s().resetToApp,
      description: s().resetToAppConfirm({ name: props.skill.name, app: props.appName }),
      confirm: s().resetToApp,
    });
    if (!agreed) return;
    setResetting(true);
    const response = await coreClient.admin.core["ai-skills"][":skillId"].reset
      .$post({
        param: { skillId: props.skill.shortId },
        json: { expectedRevision: props.skill.revision, expectedAppVersion: appVersion, confirmed: true },
      })
      .catch(() => null);
    if (response?.ok) return props.onReset();
    setResetting(false);
    toast(response ? await readError(response, s().skillResetFailed) : s().skillResetFailed, { status: "bad" });
  };
  return (
    <Dialog
      title={props.skill.name}
      open
      onOpenChange={(next) => {
        if (!next && !resetting()) props.onClose();
      }}
      foot={
        <>
          <Button disabled={resetting()} onClick={() => props.onClose()}>
            {s().close}
          </Button>
          <Show when={props.skill.source?.status !== "current" && version.data()?.app}>
            <Button variant="primary" icon="restore" busy={resetting()} onClick={() => void reset()}>
              {s().resetToApp}
            </Button>
          </Show>
        </>
      }
    >
      <Text muted>{s().compareWithAppSubtitle({ app: props.appName })}</Text>
      <Show when={!version.loading()} fallback={<Loading rows={4} />}>
        <Show when={version.data()} fallback={<Failed text={version.error()?.message ?? s().appVersionFailed} onRetry={() => void version.refresh()} />}>
          {(answer) => (
            <Show when={answer().app} fallback={<Empty icon="plug-off" text={s().appVersionMissing} />}>
              <Show when={files().length > 0} fallback={<Empty icon="check" text={s().appVersionMatches} />}>
                <Text type="meta" muted>
                  {s().diffLegend}
                </Text>
                <Canvas label={t().diffLabel}>
                  <SkillDiff files={files()} replaced={s().diffReplaced} unchanged={(count) => s().unchangedLines({ count })} />
                </Canvas>
              </Show>
            </Show>
          )}
        </Show>
      </Show>
    </Dialog>
  );
}
