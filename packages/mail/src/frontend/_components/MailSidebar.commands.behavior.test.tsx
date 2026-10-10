import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

if (!isServer) {
  test("mailbox commands follow write access and dispose with the sidebar", async () => {
    const dom = createDomTestHarness();
    const { default: MailSidebar } = await import("./MailSidebar");
    const { contextCommandsWithShortcuts } = await import("@k2b/cloud/browser/testing");
    const [canWrite, setCanWrite] = createSignal(true);
    const dispose = render(
      () => (
        <MailSidebar
          mailboxId="Box001"
          mailboxName="Support"
          syncEnabled={true}
          needsConnection={false}
          folders={[]}
          localTags={[]}
          savedViews={[]}
          scheduledMode={false}
          scheduledCount={0}
          activeFolderId={null}
          activeView={null}
          activeSavedViewId={null}
          activeTagId={null}
          searchActive={false}
          viewCounts={{
            needs_action: 0,
            mine: 0,
            unassigned: 0,
            waiting: 0,
            done: 0,
            snoozed: 0,
            send_problems: 0,
            recently_active: 0,
            kept: 0,
          }}
          canWrite={canWrite()}
          canAdmin={false}
          assignedOnly={false}
          managementOpening={null}
          settingsOpening={false}
          detailsOpening={false}
          onOpenDetails={() => {}}
          onOpenHealth={() => {}}
          onOpenSharedLinks={() => {}}
          onOpenRemoteContent={() => {}}
          onOpenSubscriptions={() => {}}
          onOpenSettings={() => {}}
          onMoveConversation={() => {}}
          onNavigate={() => {}}
        />
      ),
      dom.root,
    );
    const commands = () => contextCommandsWithShortcuts();
    try {
      expect(commands().find((command) => command.id === "mail.compose")).toMatchObject({
        shortcut: "mod+alt+n",
        description: "Write an email from “Support”. Nothing is sent yet.",
      });
      expect(commands().find((command) => command.id === "mail.search")).toMatchObject({
        shortcut: "mod+shift+k",
        action: { search: { scope: { ref: { type: "mail.mailbox", id: "Box001" }, label: "Support" } } },
      });
      setCanWrite(false);
      expect(commands().map((command) => command.id)).toEqual(["mail.search"]);
      setCanWrite(true);
      expect(commands().filter((command) => command.id === "mail.compose")).toHaveLength(1);
      dispose();
      expect(commands()).toEqual([]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("sync mailbox waits while the account must be connected again", async () => {
    const dom = createDomTestHarness();
    const { default: MailSidebar } = await import("./MailSidebar");
    const [needsConnection, setNeedsConnection] = createSignal(true);
    const dispose = render(
      () => (
        <MailSidebar
          mailboxId="Box001"
          mailboxName="Support"
          syncEnabled={true}
          needsConnection={needsConnection()}
          folders={[]}
          localTags={[]}
          savedViews={[]}
          scheduledMode={false}
          scheduledCount={0}
          activeFolderId={null}
          activeView={null}
          activeSavedViewId={null}
          activeTagId={null}
          searchActive={false}
          viewCounts={{
            needs_action: 0,
            mine: 0,
            unassigned: 0,
            waiting: 0,
            done: 0,
            snoozed: 0,
            send_problems: 0,
            recently_active: 0,
            kept: 0,
          }}
          canWrite={true}
          canAdmin={true}
          assignedOnly={false}
          managementOpening={null}
          settingsOpening={false}
          detailsOpening={false}
          onOpenDetails={() => {}}
          onOpenHealth={() => {}}
          onOpenSharedLinks={() => {}}
          onOpenRemoteContent={() => {}}
          onOpenSubscriptions={() => {}}
          onOpenSettings={() => {}}
          onMoveConversation={() => {}}
          onNavigate={() => {}}
        />
      ),
      dom.root,
    );
    const syncItem = () =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")).find((item) =>
        item.textContent?.includes("Sync mailbox"),
      );
    try {
      dom.document.querySelector<HTMLButtonElement>(".k2b-dropdown__trigger")?.click();
      expect(syncItem()?.getAttribute("aria-disabled")).toBe("true");
      setNeedsConnection(false);
      expect(syncItem()?.getAttribute("aria-disabled")).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
