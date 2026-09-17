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
          viewCounts={{ needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0 }}
          canWrite={canWrite()}
          canAdmin={false}
          managementOpening={null}
          settingsOpening={false}
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
}
