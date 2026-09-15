import WorkspaceNavigation from "@k2b/cloud/ssr/WorkspaceNavigation.island";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation } from "@k2b/ui";

export const InventoryLinks = () => (
  <WorkspaceNavigation label="Inventory" items={[{ id: "items", label: "Items", href: "/app/inventory/items", active: true }]} />
);

export function InventoryNavigation(props: { count: () => number; saving: () => boolean; openEditor: () => void }) {
  const navigation = createNavigation({
    items: () => [
      { id: "items", label: "Items", href: "/app/inventory/items", badge: props.count() },
      { id: "new", label: "New item", action: "new", disabled: props.saving() },
    ],
    onAction: (action) => {
      if (action === "new") props.openEditor();
    },
  });
  return <WorkspaceNavigationProvider label="Inventory" navigation={navigation} />;
}
