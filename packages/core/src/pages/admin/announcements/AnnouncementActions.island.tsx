import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { AnnouncementEntry, CreateAnnouncement, UpdateAnnouncement } from "@k2b/cloud/contracts";
import { adminMessages } from "../messages";

const errorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null);
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  return fallback;
};

const toIso = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
};

type FormResult = {
  kind: "announcement" | "banner";
  title: string;
  body: string;
  tone: "info" | "success" | "warning" | "danger";
  publishedAt?: string;
  expiresAt?: string;
};

type AdminMessages = ReturnType<typeof adminMessages.resolve>["t"];

const openAnnouncementForm = (t: AdminMessages, entry?: AnnouncementEntry) =>
  prompts.form({
    title: entry ? t.editAnnouncement : t.newAnnouncement,
    icon: entry ? "ti ti-pencil" : "ti ti-plus",
    confirmText: entry ? t.save : t.create,
    size: "large",
    fields: {
      kind: {
        type: "select" as const,
        label: t.type,
        description: t.typeDescription,
        options: [
          { id: "announcement", label: t.announcement, description: t.announcementDescription, icon: "ti ti-speakerphone" },
          { id: "banner", label: t.banner, description: t.bannerDescription, icon: "ti ti-message" },
        ],
        default: entry?.kind ?? "announcement",
        required: true,
      },
      title: {
        type: "text" as const,
        label: t.title,
        description: t.titleDescription,
        default: entry?.title,
        required: true,
        maxLength: 180,
      },
      body: {
        type: "text" as const,
        label: t.body,
        description: t.bodyDescription,
        default: entry?.body,
        markdown: true,
        lines: 10,
        required: true,
        maxLength: 20_000,
      },
      tone: {
        type: "select" as const,
        label: t.tone,
        description: t.toneDescription,
        options: [
          { id: "info", label: t.info, icon: "ti ti-info-circle" },
          { id: "success", label: t.success, icon: "ti ti-circle-check" },
          { id: "warning", label: t.warning, icon: "ti ti-alert-triangle" },
          { id: "danger", label: t.danger, icon: "ti ti-alert-circle" },
        ],
        default: entry?.tone ?? "info",
        required: true,
      },
      publishedAt: {
        type: "text" as const,
        label: t.publishDate,
        description: t.publishDateDescription,
        placeholder: new Date().toISOString(),
        default: entry?.publishedAt,
      },
      expiresAt: {
        type: "text" as const,
        label: t.expiryDate,
        description: t.expiryDateDescription,
        placeholder: t.noExpiry,
        default: entry?.expiresAt ?? "",
      },
    },
  }) as Promise<FormResult | null>;

const toCreatePayload = (result: FormResult): CreateAnnouncement => ({
  kind: result.kind,
  title: result.title.trim(),
  body: result.body.trim(),
  tone: result.tone,
  publishedAt: toIso(result.publishedAt),
  expiresAt: toIso(result.expiresAt),
});

const toUpdatePayload = (result: FormResult): UpdateAnnouncement => ({
  kind: result.kind,
  title: result.title.trim(),
  body: result.body.trim(),
  tone: result.tone,
  publishedAt: toIso(result.publishedAt),
  expiresAt: toIso(result.expiresAt) ?? null,
});

function CreateAnnouncementButton() {
  const locale = useLocale();
  const t = () => adminMessages.resolve([locale()]).t;
  const create = mutations.create<AnnouncementEntry, CreateAnnouncement>({
    mutation: async (data) => {
      const response = await coreClient.admin.core.announcements.$post({ json: data });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFailed));
      return response.json();
    },
    onSuccess: () => {
      toast.success(t().created);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().createFailed),
  });

  const handleClick = async () => {
    const result = await openAnnouncementForm(t());
    if (!result) return;
    create.mutate(toCreatePayload(result));
  };

  return (
    <Button type="button" size="sm" onClick={handleClick} loading={create.loading()} loadingLabel={t().creating}>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().new}
    </Button>
  );
}

function AnnouncementRowActions(props: { entry: AnnouncementEntry }) {
  const locale = useLocale();
  const t = () => adminMessages.resolve([locale()]).t;
  const update = mutations.create<AnnouncementEntry, UpdateAnnouncement>({
    mutation: async (data) => {
      const response = await coreClient.admin.core.announcements[":id"].$patch({
        param: { id: props.entry.id },
        json: data,
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().updateFailed));
      return response.json();
    },
    onSuccess: () => {
      toast.success(t().updated);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().updateFailed),
  });

  const remove = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core.announcements[":id"].$delete({ param: { id: props.entry.id } });
      if (!response.ok) throw new Error(await errorMessage(response, t().deleteFailed));
    },
    onSuccess: () => {
      toast.success(t().deleted);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().deleteFailed),
  });

  const handleEdit = async () => {
    const result = await openAnnouncementForm(t(), props.entry);
    if (!result) return;
    update.mutate(toUpdatePayload(result));
  };

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteConfirm({ title: props.entry.title }), {
      title: t().deleteAnnouncement,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) remove.mutate();
  };

  return (
    <div class="flex justify-end gap-1">
      <Tooltip.Anchor content={t().editAnnouncement}>
        <IconButton
          label={t().editAnnouncement}
          size="sm"
          onClick={handleEdit}
          loading={update.loading()}
          loadingLabel={t().editingAnnouncement}
        >
          <i class="ti ti-pencil" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
      <Tooltip.Anchor content={t().deleteAnnouncement}>
        <IconButton
          label={t().deleteAnnouncement}
          variant="danger"
          size="sm"
          onClick={handleDelete}
          loading={remove.loading()}
          loadingLabel={t().deletingAnnouncement}
        >
          <i class="ti ti-trash" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
    </div>
  );
}

type AnnouncementActionsProps = { mode: "create" } | { mode: "row"; entry: AnnouncementEntry };

export default function AnnouncementActions(props: AnnouncementActionsProps) {
  if (props.mode === "create") return <CreateAnnouncementButton />;
  return <AnnouncementRowActions entry={props.entry} />;
}
