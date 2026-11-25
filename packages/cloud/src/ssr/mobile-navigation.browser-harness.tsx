import { createNavigation } from "@k2b/ui";
import { render } from "solid-js/web";
import { openCloudMobileMenu } from "./MobileNavigation";
import { provideWorkspaceNavigation } from "./workspace-navigation";

const owner = document.getElementById("workspace")!;
render(() => {
  const navigation = createNavigation({
    // `<html data-folds>`: a mailbox with its folders, among them a fold without a symbol ("Mehr")
    items: () =>
      document.documentElement.dataset.folds === undefined
        ? [{ id: "notes", label: "Notes", href: "#notes", active: true }]
        : [
            {
              id: "box",
              label: "Kontakt",
              icon: "ti ti-mail",
              href: "#box",
              disclosure: false,
              children: [
                { id: "inbox", label: "Posteingang", icon: "ti ti-inbox", href: "#inbox", active: true },
                { id: "more", label: "Mehr", children: [{ id: "spam", label: "Spam", icon: "ti ti-alert-octagon", href: "#spam" }] },
                { id: "suppliers", label: "Lieferanten", icon: "ti ti-folder", href: "#suppliers" },
              ],
            },
          ],
    switcher: () => ({
      currentId: "work",
      label: "Work",
      icon: "ti-notebook",
      switchLabel: "Switch notebook",
      options: [{ id: "work", label: "Work", href: "#work" }],
    }),
  });
  provideWorkspaceNavigation(navigation, { label: () => "Workspace", owner: () => owner });
  return <button onClick={() => void openCloudMobileMenu({ apps: [], legalLinks: [] })}>Open menu</button>;
}, owner);
