import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, IconButton, prompts, Tooltip, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  notebookId: string;
  variant?: "compact" | "chip" | "sidebar" | "icon";
  viewTransitionName?: string;
};

type CreateNoteResult = {
  id: string;
};

const CreateNoteButton = (props: Props) => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const mutation = mutations.create<CreateNoteResult, void>({
    mutation: async () => {
      const res = await apiClient[":id"].notes.$post({
        param: { id: props.notebookId },
        json: {},
      });
      if (!res.ok) throw new Error(t().failedCreateNote);
      return (await res.json()) as CreateNoteResult;
    },
    onSuccess: (data) => {
      void navigateToNotebookNote(buildNoteUrl(props.notebookId, data.id), { selectInitialTitle: data.id });
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleCreate = () => mutation.mutate();

  if (props.variant === "compact") {
    return (
      <IconButton
        label={t().newNote}
        tooltip={t().newNote}
        size="xs"
        onClick={handleCreate}
        loading={mutation.loading()}
        loadingLabel={t().creatingNote}
      >
        <i class={`ti ${mutation.loading() ? "ti-loader-2 animate-spin" : "ti-file-plus"}`} />
      </IconButton>
    );
  }

  if (props.variant === "icon") {
    return (
      <Tooltip.Anchor content={t().newNote} class="w-full">
        <AppWorkspace.SidebarIconAction
          label={t().newNote}
          icon={mutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"}
          tone="success"
          onClick={handleCreate}
          disabled={mutation.loading()}
          viewTransitionName={props.viewTransitionName}
        />
      </Tooltip.Anchor>
    );
  }

  if (props.variant === "chip") {
    return (
      <Button size="sm" onClick={handleCreate} loading={mutation.loading()} loadingLabel={t().creatingNote}>
        {mutation.loading() ? (
          <i class="ti ti-loader-2 animate-spin" />
        ) : (
          <>
            <i class="ti ti-plus" />
            <span>{t().newNote}</span>
          </>
        )}
      </Button>
    );
  }

  if (props.variant === "sidebar") {
    return (
      <AppWorkspace.SidebarItem
        icon={mutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"}
        tone="success"
        onClick={handleCreate}
        disabled={mutation.loading()}
      >
        {t().newNote}
      </AppWorkspace.SidebarItem>
    );
  }

  return (
    <Button variant="success" onClick={handleCreate} loading={mutation.loading()} loadingLabel={t().creatingNote}>
      {mutation.loading() ? (
        <i class="ti ti-loader-2 animate-spin" />
      ) : (
        <>
          <i class="ti ti-file-plus mr-1 text-emerald-600 dark:text-emerald-400" />
          <span class="text-emerald-700 dark:text-emerald-300">{t().newNote}</span>
        </>
      )}
    </Button>
  );
};

export default CreateNoteButton;
