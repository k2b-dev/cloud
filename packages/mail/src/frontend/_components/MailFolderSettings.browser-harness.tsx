import { LocaleProvider, SettingsModal } from "@k2b/ui";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import type { MailAdminFolderView } from "../../service/folders";
import MailFolderSettings from "./MailFolderSettings";
import { mailSettingsMessages } from "./mail-settings-messages";

export type FolderSettingsHarnessOptions = {
  locale: "en" | "de";
  folders: MailAdminFolderView[];
};

declare global {
  interface Window {
    mountFolderSettings: (options: FolderSettingsHarnessOptions) => void;
  }
}

window.mountFolderSettings = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const messages = mailSettingsMessages.resolve([options.locale]).t;
  // Like Mail's settings: the change shows at once, and the reload brings the server's view of the tree.
  const [state, setState] = createStore({ folders: options.folders });
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <SettingsModal title={messages.mailboxSettings} defaultTab="folders">
          <SettingsModal.Group title={messages.delivery}>
            <SettingsModal.Tab id="folders" title={messages.folders} icon="ti ti-folders" description={messages.foldersDescription}>
              <MailFolderSettings
                mailboxId="Box001"
                folders={state.folders}
                reloading={false}
                onReload={async () => {}}
                onWorkspaceChange={() => {}}
                onFolderVisibilityChange={(folderId, display) =>
                  setState("folders", (folder) => folder.id === folderId, "display", display)
                }
                onFolderRoleChange={() => {}}
                folderRolePending={false}
              />
            </SettingsModal.Tab>
          </SettingsModal.Group>
        </SettingsModal>
      </LocaleProvider>
    ),
    host,
  );
};
