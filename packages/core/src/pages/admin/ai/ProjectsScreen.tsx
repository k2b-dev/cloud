import { coreClient } from "@k2b/cloud/clients/core";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import {
  Bar,
  Button,
  Dialog,
  Facts,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Path,
  Section,
  StatusRow,
  Table,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, onCleanup, Show } from "solid-js";
import { StateDot } from "../_area/StateWord";
import { settingsMessages } from "../settings/_components/messages";
import { openProjectAccess, readError } from "./content-access";
import type { AiProjectRow, AiProjectsData } from "./content-data";
import { aiContentMessages } from "./content-messages";
import { type ContentAddress, ContentPager, ContentSearch, contentHref } from "./content-parts";
import { aiAreaLink, aiSectionLabel } from "./frame";

/**
 * Projects on v2: the shared AI Projects as a table with search and pages, the open Project beside it with its facts
 * and deeds (permissions, delete). Search, page and the open Project live in the address.
 */
export default function ProjectsScreen(props: { nav: NavProps; data: AiProjectsData }) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const t = () => aiContentMessages.resolve([locale()]).t;
  const toast = useToast();
  const data = () => props.data;
  const address = (): ContentAddress => ({ sec: "projects", search: data().search, page: data().page, open: data().open });
  const pages = () => Math.max(1, Math.ceil(data().total / data().perPage));
  const open = () => data().projects.find((project) => project.shortId === data().open);
  const listHref = () => contentHref({ ...address(), open: null });
  const reload = () => navigateTo(window.location.pathname + window.location.search);

  const loading = new AbortController();
  onCleanup(() => loading.abort());
  const [accessBusy, setAccessBusy] = createSignal(false);
  const editAccess = async (project: AiProjectRow) => {
    if (accessBusy()) return;
    setAccessBusy(true);
    try {
      if (await openProjectAccess(project, locale(), loading.signal)) reload();
    } catch (error) {
      if (!loading.signal.aborted) toast(error instanceof Error ? error.message : s().loadProjectPermissionsFailed, { status: "bad" });
    } finally {
      setAccessBusy(false);
    }
  };
  const [deleting, setDeleting] = createSignal(false);
  const remove = async (project: AiProjectRow) => {
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    const agreed = await Dialog.confirm({
      title: s().deleteProject,
      description: s().deleteProjectConfirm({ name: project.name }),
      confirm: s().delete,
    });
    if (!agreed) return;
    setDeleting(true);
    const response = await coreClient.admin.core["ai-projects"][":projectId"]
      .$delete({ param: { projectId: project.shortId } })
      .catch(() => null);
    if (response?.ok) return navigateTo(listHref());
    setDeleting(false);
    toast(response ? await readError(response, s().deleteProjectFailed) : s().deleteProjectFailed, { status: "bad" });
  };
  const adminsText = (project: AiProjectRow) => (project.adminCount === 0 ? s().noAdmins : t().admins({ count: project.adminCount }));
  const noAdmins = () => (
    <Text tone="bad" weight="medium">
      <StateDot /> {s().noAdmins}
    </Text>
  );

  /** The list; beside an open entry it keeps its width and a grip, alone it takes the page (no empty half). */
  const listPane = (split: boolean) => (
    <Pane
      label={t().projectsList}
      width={split ? { min: 420, default: 560 } : undefined}
      scrollKey="admin-ai-projects"
      status={
        // k2b-ui gap: Hero figure (#4360); the summary's count is the statement until the figure type exists
        <StatusRow
          lead={
            data().search
              ? t().matches({ count: data().summary.total, search: data().search })
              : t().projectsLead({ count: data().summary.total })
          }
          facts={[
            { value: data().summary.totalAccess.toLocaleString(locale()), after: t().accessAfter },
            ...(pages() > 1 ? [{ value: t().pageOf({ page: data().page, pages: pages() }) }] : []),
          ]}
          filters={<ContentPager address={address()} pages={pages()} t={t()} />}
        />
      }
    >
      <Show when={data().summary.unmanaged > 0}>
        <Notice tone="bad" title={t().projectsUnmanaged({ count: data().summary.unmanaged })}>
          {t().unmanagedText}
        </Notice>
      </Show>
      <Table
        label={t().projectsList}
        rows={data().projects}
        rowKey={(project) => project.shortId}
        current={data().open ?? undefined}
        open={(project) => ({ href: contentHref({ ...address(), open: project.shortId }) })}
        empty={
          data().search
            ? {
                icon: "filter-off",
                text: s().noProjectsMatch({ search: data().search }),
                action: { label: t().showAll, href: contentHref({ sec: "projects", search: "", page: 1 }) },
              }
            : { icon: "folders", text: s().noProjects }
        }
        phone={(project) => ({
          // slot for #4208/#4223 (DP): the Project's mark leads the phone row
          lines: [
            project.name,
            <>
              <Show when={project.adminCount === 0} fallback={adminsText(project)}>
                {noAdmins()}
              </Show>
              {` · ${t().entries({ count: project.accessCount })}`}
            </>,
          ],
          time: project.updated,
        })}
        columns={[
          {
            title: s().project,
            width: { min: 180, default: 300 },
            // slot for #4208/#4223 (DP): Column mark, the Project's own symbol (project.icon without "ti ti-", else "folders") in AI_COLOR
            cell: (project) => project.name,
          },
          {
            title: s().admins,
            width: { min: 140, default: 180 },
            cell: (project) => (project.adminCount === 0 ? noAdmins() : adminsText(project)),
          },
          {
            title: s().access,
            width: { min: 72, default: 84 },
            align: "end",
            cell: (project) => project.accessCount.toLocaleString(locale()),
          },
          { title: s().updated, drop: true, cell: (project) => project.updated },
        ]}
      />
    </Pane>
  );
  /** The open entry beside the list; on the phone it is the page, with the way back to the list. */
  const detailPane = (project: AiProjectRow) => (
    <Pane
      detail
      label={project.name}
      back={{ label: t().projectsList, href: listHref() }}
      head={
        <Bar
          start={
            // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the Project's mark; the name stands in
            <Text type="body" weight="strong">
              {project.name}
            </Text>
          }
          end={
            <>
              <Button icon="shield" busy={accessBusy()} onClick={() => void editAccess(project)}>
                {s().permissions}
              </Button>
              <Menu
                label={s().actionsFor({ name: project.name })}
                disabled={deleting()}
                items={[{ label: s().deleteProject, icon: "trash", danger: true, onClick: () => void remove(project) }]}
              />
              <Button variant="ghost" icon="x" label={t().closeDetail} href={listHref()} />
            </>
          }
        />
      }
    >
      <Show when={project.adminCount === 0}>
        <Notice tone="bad" title={t().noAdminTitle}>
          {t().projectNoAdminText}
        </Notice>
      </Show>
      <Show when={project.description}>
        <Text>{project.description}</Text>
      </Show>
      <Section icon="info-circle" title={t().details}>
        <Facts
          items={[
            { label: s().access, value: t().entries({ count: project.accessCount }) },
            // no admin stands as the notice above; the fact says it only once
            ...(project.adminCount === 0 ? [] : [{ label: s().admins, value: adminsText(project) }]),
            { label: s().updated, value: project.updated },
            { label: t().created, value: project.created },
            { label: t().id, value: project.shortId, mono: true, copy: project.shortId },
          ]}
        />
      </Section>
    </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while a Project is open: no empty half (identity rule 5)
      detail={open() ? 440 : undefined}
      head={
        <Bar
          start={
            <Path label={aiAreaLink(locale()).label} items={[aiAreaLink(locale()), { label: aiSectionLabel(locale(), "projects") }]} />
          }
          end={<ContentSearch address={address()} label={s().searchAiProjects} placeholder={t().searchPlaceholder} />}
        />
      }
    >
      <Show when={open()} fallback={listPane(false)}>
        {(project) => (
          <Pane.Split>
            {listPane(true)}
            {detailPane(project())}
          </Pane.Split>
        )}
      </Show>
    </AdminWorkspace>
  );
}
