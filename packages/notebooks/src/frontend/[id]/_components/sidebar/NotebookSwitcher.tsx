import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import { listAccessibleNotebooks } from "./notebooks";
import type { Notebook } from "./types";

const iconClass = (icon: string | null) => (icon ? (icon.startsWith("ti ") ? icon : `ti ${icon}`) : "ti ti-notebook");

/**
 * The notebook's name at the top of the sidebar. It opens the other notebooks and the overview of all of them. The
 * list loads when a pointer or the focus first reaches the name, so it is usually there when the menu opens.
 */
export default function NotebookSwitcher(props: { notebook: Notebook }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [others, setOthers] = createSignal<Notebook[] | null>(null);
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const load = () => {
    if (requested) return;
    requested = true;
    setFailed(false);
    listAccessibleNotebooks(locale())
      .then((notebooks) => setOthers(notebooks.filter((notebook) => notebook.id !== props.notebook.id)))
      .catch(() => {
        // The next pointer, focus or opening tries again.
        requested = false;
        setFailed(true);
      });
  };
  const items = (): DropdownItem[] => [
    {
      sectionLabel: t().switchNotebook,
      items: [
        // Choosing the open notebook only closes the menu.
        { icon: iconClass(props.notebook.icon), label: props.notebook.name, description: t().thisNotebook, action: () => undefined },
        ...(others()?.map((notebook) => ({
          icon: iconClass(notebook.icon),
          label: notebook.name,
          href: `/app/notebooks/${notebook.id}`,
        })) ?? [
          {
            icon: failed() ? "ti ti-alert-circle" : "ti ti-loader-2",
            label: failed() ? t().failedLoadNotebooks : t().loadingNotebooks,
            disabled: true as const,
          },
        ]),
      ],
    },
    { sectionLabel: "", items: [{ icon: "ti ti-library", label: t().allNotebooks, href: "/app/notebooks" }] },
  ];

  return (
    <Dropdown.Root
      position="bottom-left"
      class="min-w-0 flex-1"
      items={items()}
      label={t().switchNotebook}
      onOpenChange={(open) => open && load()}
    >
      <Dropdown.Trigger
        variant="ghost"
        align="start"
        class="notebook-sidebar-switcher w-full min-w-0"
        title={t().switchNotebook}
        onPointerEnter={load}
        onFocus={load}
      >
        <span class="notebook-sidebar-switcher__icon" aria-hidden="true">
          <i class={iconClass(props.notebook.icon)} />
        </span>
        <span class="min-w-0 flex-1 truncate text-left">{props.notebook.name}</span>
        <i class="ti ti-selector shrink-0 text-dimmed" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
