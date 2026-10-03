import {
  BottomSheet,
  Button,
  bottomSheetOptions,
  confirmDiscardIfDirty,
  createNavigation,
  dialogCore,
  type InstallationPlatform,
  InstallGuide,
  type InstallPrompt,
  MobileShell,
  Navigation,
  QrScanner,
  SegmentedControl,
  TabBar,
  type TabBarItem,
  TextInput,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { DemoCard } from "../DemoCard";

/** The host owns opening and dismissal; the same controller works inline or in a sheet. */
export function NavigationDemo() {
  const [active, setActive] = createSignal("inbox");
  const [count, setCount] = createSignal(3);
  const navigation = createNavigation({
    items: () => [
      { id: "inbox", action: "inbox", label: "Inbox", icon: "ti ti-inbox", badge: count(), active: active() === "inbox" },
      {
        id: "projects",
        label: "Projects",
        children: [
          {
            id: "work",
            action: "work",
            label: "A project with a long name that remains readable on a narrow screen",
            icon: "ti ti-folder",
            active: active() === "work",
            actions: [{ id: "rename", action: "rename", label: "Rename project", icon: "ti ti-pencil" }],
          },
          { id: "pending", action: "pending", label: "Waiting for access", disabled: true },
        ],
      },
      { id: "docs", label: "Workspace documentation", href: "/en/ui/layout/workspace", icon: "ti ti-book" },
    ],
    onAction: (action) => {
      setActive(action);
    },
  });
  const open = () =>
    dialogCore.open<void>(
      (close, context) => (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title="Workspace menu" close={() => void context.requestDismiss()} />
          <BottomSheet.Body>
            <Navigation label="Workspace" navigation={navigation} beforeSelect={() => close()} />
          </BottomSheet.Body>
          <BottomSheet.Footer>
            <Button variant="ghost" onClick={() => setCount((value) => value + 1)}>
              Simulate live update
            </Button>
          </BottomSheet.Footer>
        </BottomSheet>
      ),
      bottomSheetOptions,
    );
  return (
    <DemoCard
      id="navigation"
      chip={{ kind: "component", name: "Navigation", from: "@k2b/ui" }}
      description="One live navigation model, native links, local actions and readable nested rows. The host chooses where it renders."
      code={`const navigation = createNavigation({\n  items: () => [{ id: "inbox", label: "Inbox", action: "inbox", badge: count() }],\n  onAction: id => setActive(id),\n});\n<Navigation navigation={navigation} label="Workspace" />`}
    >
      <div class="flex flex-col gap-3 max-w-xl">
        <Button onClick={() => void open()}>Open menu sheet</Button>
        <p>Selected: {active()}</p>
        <Navigation navigation={navigation} label="Inline workspace" />
      </div>
    </DemoCard>
  );
}

export function BottomSheetDemo() {
  const open = () =>
    dialogCore.open<void>((close, context) => {
      const [name, setName] = createSignal("");
      context.setDismissHandler(async () => {
        if (await confirmDiscardIfDirty(() => name().length > 0)) close();
      });
      return (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header
            title="Edit a draft"
            subtitle="Drag the handle, press Escape or use Close."
            close={() => void context.requestDismiss()}
          />
          <BottomSheet.Body>
            <TextInput label="Draft name" value={name} onValueChange={setName} />
          </BottomSheet.Body>
          <BottomSheet.Footer>
            <Button variant="secondary" onClick={() => void context.requestDismiss()}>
              Close
            </Button>
            <Button onClick={() => close()}>Save draft</Button>
          </BottomSheet.Footer>
        </BottomSheet>
      );
    }, bottomSheetOptions);
  return (
    <DemoCard
      id="bottom-sheet"
      chip={{ kind: "component", name: "BottomSheet", from: "@k2b/ui" }}
      description="A bottom-edge dialog with guarded dismissal, a touch handle, safe-area spacing and the shared focus trap. Enter a draft to exercise the discard guard."
      code={`dialogCore.open((close, context) => <BottomSheet onDismiss={context.requestDismiss}>\n  <BottomSheet.Header title="Details" close={context.requestDismiss} />\n  <BottomSheet.Body>Content</BottomSheet.Body>\n</BottomSheet>, bottomSheetOptions);`}
    >
      <Button onClick={() => void open()}>Open bottom sheet</Button>
    </DemoCard>
  );
}

const phoneTabs: TabBarItem[] = [
  { id: "start", label: "Start", icon: "ti ti-home", href: "#mobile-shell", current: true },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "#mobile-shell" },
  { id: "contacts", label: "Contacts", icon: "ti ti-address-book", href: "#mobile-shell" },
  { id: "settings", label: "Settings", icon: "ti ti-settings", href: "#mobile-shell" },
];

const phoneTasks = ["Call the venue about Friday", "Send the signed offer", "Order name badges", "Book the train to Leipzig"];

/**
 * A mounted MobileShell takes over the whole document's scrolling and gestures, so the catalog shows its parts in a
 * phone-sized frame: the header, one scrolling body, and the tab bar.
 */
export function MobileShellDemo() {
  return (
    <DemoCard
      id="mobile-shell"
      chip={[
        { kind: "component", name: "MobileShell", from: "@k2b/ui" },
        { kind: "component", name: "TabBar", from: "@k2b/ui" },
      ]}
      description="The parts of a phone app frame in a 390 px frame: a header with Back, one scrolling body, and the tab bar. MobileShell itself is the page layout, so this catalog page does not mount it."
      code={`<MobileShell
  header={<MobileShell.Header title="Tasks" back={{ href: "/pwa/", label: "Start" }} />}
  footer={<TabBar label="App" items={tabs} />}
>
  <TaskRows />
</MobileShell>`}
    >
      <div class="ui-phone-frame">
        <MobileShell.Header title="Tasks" back={{ href: "#mobile-shell", label: "Start" }} />
        <ol class="ui-phone-frame__body">
          <For each={phoneTasks}>{(task) => <li>{task}</li>}</For>
        </ol>
        <TabBar label="Phone app" items={phoneTabs.map((item) => ({ ...item, current: item.id === "tasks" }))} />
      </div>
    </DemoCard>
  );
}

export function TabBarDemo() {
  return (
    <DemoCard
      id="tab-bar"
      chip={{ kind: "component", name: "TabBar", from: "@k2b/ui" }}
      description="Up to five native links with an icon above each label; the open page carries aria-current. Flat and opaque, with a hairline above."
      code={`<TabBar label="App" items={[
  { id: "start", label: "Start", icon: "ti ti-home", href: "/pwa/", current: true },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/pwa/spaces" },
]} />`}
    >
      <div class="ui-phone-frame" data-size="bar">
        <TabBar label="Phone app" items={phoneTabs} />
      </div>
    </DemoCard>
  );
}

const platforms: { value: InstallationPlatform; label: string }[] = [
  { value: "apple-mobile", label: "iPhone" },
  { value: "android", label: "Android" },
  { value: "apple-desktop", label: "Mac" },
  { value: "generic", label: "Other" },
  { value: "in-app", label: "In-app" },
];

/** A fixed installation state per platform; a real page uses createInstallPrompt() in the browser. */
const previewPrompt = (platform: InstallationPlatform): InstallPrompt => ({
  platform,
  installed: () => false,
  canPrompt: () => false,
  busy: () => false,
  requested: () => false,
  failed: () => false,
  install: async () => {},
});

export function InstallGuideDemo() {
  const [platform, setPlatform] = createSignal<InstallationPlatform>("apple-mobile");
  return (
    <DemoCard
      id="install-guide"
      chip={{ kind: "component", name: "InstallGuide", from: "@k2b/ui" }}
      description="Installation guidance for the browser in use: the browser's own dialog where it offers one, otherwise the steps for iPhone and iPad, Android, Safari on a Mac, other browsers, or a link to copy out of an in-app browser."
      code={`const install = createInstallPrompt();
<InstallGuide appName="Northwind" install={install} url={location.href} />`}
    >
      <div class="ui-install-guide-demo">
        <SegmentedControl label="Platform" options={platforms} value={platform} onValueChange={setPlatform} size="sm" />
        <Show keyed when={platform()}>
          {(current) => <InstallGuide appName="Northwind" install={previewPrompt(current)} url="https://cloud.example/pwa/" />}
        </Show>
      </div>
    </DemoCard>
  );
}

export function QrScannerDemo() {
  const [scanning, setScanning] = createSignal(false);
  const [result, setResult] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  return (
    <DemoCard
      id="qr-scanner"
      chip={{ kind: "component", name: "QrScanner", from: "@k2b/ui" }}
      description="Scans a QR code with the rear camera. The host accepts or rejects each decoded text; a rejected code turns the frame red. Camera images stay on the device."
      code={`<QrScanner
  instructions="Point the camera at the pairing code."
  onResult={(text) => parsePairingLink(text) !== undefined}
  onStop={() => setScanning(false)}
  onError={(reason) => showPasteField(reason)}
/>`}
    >
      <div class="ui-qr-scanner-demo">
        <Show
          when={scanning()}
          fallback={
            <Button
              onClick={() => {
                setResult(undefined);
                setProblem(undefined);
                setScanning(true);
              }}
            >
              Start camera
            </Button>
          }
        >
          <QrScanner
            onResult={(text) => {
              setResult(text);
              setScanning(false);
              return true;
            }}
            onStop={() => setScanning(false)}
            onError={(reason) => {
              setScanning(false);
              setProblem(reason === "denied" ? "Camera access was denied." : "No camera is available.");
            }}
          />
          <Button variant="secondary" onClick={() => setScanning(false)}>
            Stop camera
          </Button>
        </Show>
        <Show when={result()}>{(text) => <p>Scanned: {text()}</p>}</Show>
        <Show when={problem()}>{(text) => <p role="alert">{text()}</p>}</Show>
      </div>
    </DemoCard>
  );
}
