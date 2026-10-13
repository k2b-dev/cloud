import { createNavigation } from "@k2b/ui";
import { render } from "solid-js/web";
import { openCloudMobileMenu } from "./MobileNavigation";
import { provideWorkspaceNavigation } from "./workspace-navigation";

const owner = document.getElementById("workspace")!;
render(() => {
  const navigation = createNavigation({
    items: () => [{ id: "notes", label: "Notes", href: "#notes", active: true }],
    switcher: () => ({ currentId: "work", label: "Work", icon: "ti-notebook", switchLabel: "Switch notebook" }),
  });
  provideWorkspaceNavigation(navigation, { label: () => "Workspace", owner: () => owner });
  return <button onClick={() => void openCloudMobileMenu({ apps: [], legalLinks: [] })}>Open menu</button>;
}, owner);
