import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { useToast } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import type { SpaceColumn, SpaceItem, SpaceItemResourceReferenceInput, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { openDialog } from "../../../lib/open-dialog";
import { useSpaceMessages } from "../../messages";
import { openTemplateDialog } from "../edit/TemplateDialog";
import type { CreateMenuChoice } from "../shared/create-menu";
import { createSpaceItem } from "../shared/editItem";
import ItemForm from "../shared/ItemForm";
import type { ItemType } from "../shared/item-form/types";
import { invalidateSpacesData } from "../workspace/workspace-events";

export type CreateItemProps = {
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates?: SpaceItemTemplate[];
  dateConfig?: DateContext;
  variant?: "chip" | "inline";
  defaultType?: ItemType;
  defaultColumnId?: string;
};

export type CreateItemOptions = {
  type?: ItemType;
  references?: SpaceItemResourceReferenceInput[];
  returnTo?: string;
  /** A blank item's title, such as a menu query no template matched. */
  title?: string;
  /** Opens the dialog with this template chosen; a template deleted meanwhile says so and opens it blank. */
  templateId?: string;
};

/** Creating an item in a Space: the dialog, its templates and "Create template…", for every "+" of the page. */
export function createItemController(props: CreateItemProps) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const retryToast = createRetryToasts();
  const toast = useToast();
  const defaultType = () => props.defaultType ?? "task";
  const label = () => (defaultType() === "event" ? t.newEvent : t.newTask);
  const [pending, setPending] = createSignal(false);
  const refreshWorkspace = (): void =>
    void invalidateSpacesData().catch(() => retryToast(t.workspaceRefreshAfterCreateFailed, t.retry, refreshWorkspace));
  const createItem = async (options: CreateItemOptions = {}) => {
    if (pending()) return;
    setPending(true);
    // The Space is the one the dialog opened for, even when a compose command selects another while it is open.
    const spaceId = props.spaceId;
    const template = options.templateId ? props.templates?.find((candidate) => candidate.id === options.templateId) : undefined;
    if (options.templateId && !template) toast(t.templateGone, { status: "bad" });
    try {
      // The dialog stays open until the create answers, so a failure shows in it with the input still there.
      const item = await openDialog<SpaceItem | null>(locale(), (close) => (
        <ItemForm
          spaceId={spaceId}
          columns={props.columns}
          tags={props.tags}
          templates={props.templates}
          quickCreate
          defaults={{
            type: template?.kind ?? options.type ?? defaultType(),
            columnId: props.defaultColumnId,
            references: options.references,
            title: options.title,
            templateId: template?.id,
          }}
          onSubmit={async (data) => close(await createSpaceItem(spaceId, data, t.createItemFailed))}
          onCancel={() => close(null)}
          dateConfig={props.dateConfig}
        />
      ));
      if (item) {
        // The new entry can land outside the current view or filter, so it is confirmed.
        toast(item.startsAt && item.endsAt ? t.eventCreated : t.taskCreated, { status: "ok" });
        refreshWorkspace();
      }
      if (options.returnTo) window.location.assign(options.returnTo);
    } finally {
      setPending(false);
    }
  };
  const createTemplate = async (kind: SpaceItemTemplate["kind"]) => {
    const saved = await openTemplateDialog({
      spaceId: props.spaceId,
      kind,
      tags: props.tags,
      templates: props.templates ?? [],
      dateConfig: props.dateConfig,
      locale: locale(),
    });
    if (saved) refreshWorkspace();
  };
  /** Runs what a person chose in the "+" menu. */
  const choose = (choice: CreateMenuChoice) => {
    if (choice.type === "blank") void createItem({ type: choice.kind, title: choice.title });
    else if (choice.type === "template") void createItem({ templateId: choice.template.id });
    else void createTemplate(choice.kind);
  };

  return { createItem, createTemplate, choose, pending, label, defaultType };
}
