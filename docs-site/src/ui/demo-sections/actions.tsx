import {
  Button,
  ButtonLink,
  ContextMenu,
  CopyButton,
  Disclosure,
  Dropdown,
  FilterChip,
  IconButton,
  IconButtonLink,
  openSpotlightSearch,
  RemoveButton,
  SegmentedControl,
  SplitButton,
  SpotlightButton,
  type SpotlightSearchResolver,
  Tabs,
  Toolbar,
} from "@k2b/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid, type DemoSection } from "./types";

const ButtonsDemo = () => (
  <DemoCard
    id="buttons"
    chip={[
      { kind: "component", name: "Button", from: "@k2b/ui" },
      { kind: "component", name: "ButtonLink", from: "@k2b/ui" },
      { kind: "component", name: "IconButton", from: "@k2b/ui" },
      { kind: "component", name: "IconButtonLink", from: "@k2b/ui" },
      { kind: "component", name: "SplitButton", from: "@k2b/ui" },
    ]}
    description="Package-native buttons share one variant and size contract. Input actions align with adjacent field controls, immediate actions press with a subtle flat scale without layout movement, split-button menu triggers stay still, Button defaults to primary, IconButton defaults to ghost, and text actions stay surface-free and flush with nearby copy."
    code={`<Button variant="primary">Save</Button>
<Button variant="secondary">Preview</Button>
<Button variant="ghost">Later</Button>
<Button variant="text" size="xs">More</Button>
<Button variant="warning" size="xs">Undo send · 8s</Button>
<Button variant="danger" size="sm">Delete</Button>
<Button variant="subtle" size="xs">
  <i class="ti ti-activity" aria-hidden="true" /> Status
</Button>
<Button loading loadingLabel="Saving">Save</Button>
<Button disabled>Disabled</Button>

{/* IconButton defaults to variant="ghost" */}
<IconButton label="Settings">
  <i class="ti ti-settings" />
</IconButton>
<IconButton label="Publish" variant="primary"><i class="ti ti-rocket" /></IconButton>
<IconButton label="Refresh" variant="secondary"><i class="ti ti-refresh" /></IconButton>
<IconButton label="Add filter" variant="input"><i class="ti ti-plus" /></IconButton>
<IconButton label="Delete" variant="danger">
  <i class="ti ti-trash" />
</IconButton>
<IconButton label="Saving" loading loadingLabel="Saving"><i class="ti ti-device-floppy" /></IconButton>

{/* Navigational counterparts render anchors */}
<ButtonLink href="/settings" variant="secondary">Settings</ButtonLink>
<IconButtonLink href="/settings" label="Open settings">
  <i class="ti ti-external-link" />
</IconButtonLink>

<SplitButton
  onClick={send}
  menuLabel="More send options"
  items={[
    { label: "Save as draft", icon: "ti ti-device-floppy", action: saveDraft },
    { label: "Send later", icon: "ti ti-clock", action: scheduleSend },
  ]}
>
  <i class="ti ti-send" aria-hidden="true" /> Send
</SplitButton>`}
  >
    <div class="ui-demo-row">
      <Button variant="primary">Save</Button>
      <Button variant="secondary">Preview</Button>
      <Button variant="ghost">Later</Button>
      <Button variant="text" size="xs">
        More
      </Button>
      <Button variant="subtle" size="xs">
        <i class="ti ti-activity" aria-hidden="true" /> Status
      </Button>
      <Button variant="warning" size="xs">
        Undo send · 8s
      </Button>
      <Button variant="danger" size="sm">
        Delete
      </Button>
      <Button loading loadingLabel="Saving">
        Save
      </Button>
      <Button disabled>Disabled</Button>
    </div>
    <div class="ui-demo-row">
      <IconButton label="Settings">
        <i class="ti ti-settings" aria-hidden="true" />
      </IconButton>
      <IconButton label="Publish" variant="primary">
        <i class="ti ti-rocket" aria-hidden="true" />
      </IconButton>
      <IconButton label="Refresh" variant="secondary">
        <i class="ti ti-refresh" aria-hidden="true" />
      </IconButton>
      <IconButton label="Add filter" variant="input">
        <i class="ti ti-plus" aria-hidden="true" />
      </IconButton>
      <IconButton label="Delete" variant="danger">
        <i class="ti ti-trash" aria-hidden="true" />
      </IconButton>
      <IconButton label="Saving" loading loadingLabel="Saving">
        <i class="ti ti-device-floppy" aria-hidden="true" />
      </IconButton>
      <ButtonLink href="#buttons" variant="secondary">
        Button links
      </ButtonLink>
      <IconButtonLink href="#buttons" label="Open button links">
        <i class="ti ti-external-link" aria-hidden="true" />
      </IconButtonLink>
      <SplitButton
        onClick={() => {}}
        menuLabel="More send options"
        items={[
          { label: "Save as draft", icon: "ti ti-device-floppy", action: () => {} },
          { label: "Send later", icon: "ti ti-clock", action: () => {} },
        ]}
      >
        <i class="ti ti-send" aria-hidden="true" /> Send
      </SplitButton>
    </div>
  </DemoCard>
);

const CopyRemoveDemo = () => {
  const [status, setStatus] = createSignal("No copy attempted");
  return (
    <DemoCard
      id="copy-remove"
      chip={[
        { kind: "component", name: "CopyButton", from: "@k2b/ui" },
        { kind: "component", name: "RemoveButton", from: "@k2b/ui" },
      ]}
      description="Neutral copy actions report success or failure while preserving rejected clipboard promises; remove actions keep their accessible target label."
      code={`const [status, setStatus] = createSignal("");

<CopyButton
  text="hello"
  label="Copy value"
  onCopied={() => setStatus("Copied")}
  onCopyError={() => setStatus("Copy failed")}
/>
<RemoveButton
  ariaLabel="Remove attachment"
  onClick={() => setStatus("Remove requested")}
/>`}
    >
      <div class="ui-demo-row">
        <CopyButton
          text="hello"
          label="Copy value"
          onCopied={() => setStatus("Copied successfully")}
          onCopyError={() => setStatus("Clipboard write failed")}
        />
        <CopyButton
          text="secret"
          onCopied={() => setStatus("Copied successfully")}
          onCopyError={() => setStatus("Clipboard write failed")}
        />
        <RemoveButton ariaLabel="Remove attachment" onClick={() => setStatus("Remove requested")} />
        <span aria-live="polite">{status()}</span>
      </div>
    </DemoCard>
  );
};

const MenusDemo = () => (
  <DemoCard
    id="menus"
    chip={[
      { kind: "component", name: "Dropdown", from: "@k2b/ui" },
      { kind: "component", name: "ContextMenu", from: "@k2b/ui" },
    ]}
    description="Top-layer menus with keyboard navigation, focus restoration, viewport clamping, and light dismiss. Icon-only triggers default to the quiet ghost variant; `width` is a CSS length and defaults to 12rem."
    code={`<Dropdown.Root items={[{ label: "Duplicate", action: duplicate }]}>
  <Dropdown.Trigger variant="secondary">Actions</Dropdown.Trigger>
</Dropdown.Root>

<Dropdown.Root items={items}>
  <Dropdown.Trigger iconOnly label="More actions">
    <i class="ti ti-dots" aria-hidden="true" />
  </Dropdown.Trigger>
</Dropdown.Root>

{/* width is a CSS length */}
<Dropdown.Root items={items} width="18rem" position="bottom-left">
  <Dropdown.Trigger variant="secondary">Wide menu</Dropdown.Trigger>
</Dropdown.Root>

<ContextMenu label="Record actions" items={items}>
  <div>Right click or press Shift+F10</div>
</ContextMenu>`}
  >
    <div class="ui-demo-row">
      <Dropdown.Root
        items={[
          { label: "Duplicate", icon: "ti ti-copy", action: () => {} },
          { label: "Archive", icon: "ti ti-archive", action: () => {} },
          { label: "Delete", icon: "ti ti-trash", variant: "danger", action: () => {} },
        ]}
      >
        <Dropdown.Trigger variant="secondary">Actions</Dropdown.Trigger>
      </Dropdown.Root>
      <Dropdown.Root
        variant="touch"
        items={[
          {
            sectionLabel: "Account",
            items: [
              { label: "Settings", icon: "ti ti-settings", action: () => {} },
              { label: "Sign out", icon: "ti ti-logout", action: () => {} },
            ],
          },
        ]}
      >
        <Dropdown.Trigger variant="secondary">Touch menu</Dropdown.Trigger>
      </Dropdown.Root>
      <Dropdown.Root items={[{ label: "Duplicate", icon: "ti ti-copy", action: () => {} }]}>
        <Dropdown.Trigger iconOnly label="More actions">
          <i class="ti ti-dots" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <Dropdown.Root
        width="18rem"
        position="bottom-left"
        items={[
          { label: "Export every record as CSV", icon: "ti ti-file-export", action: () => {} },
          { label: "Recalculate derived columns", icon: "ti ti-refresh", action: () => {} },
        ]}
      >
        <Dropdown.Trigger variant="secondary">Wide menu (18rem)</Dropdown.Trigger>
      </Dropdown.Root>
      <ContextMenu
        label="Record actions"
        items={[
          { label: "Open", icon: "ti ti-external-link", action: () => {} },
          { label: "Remove", icon: "ti ti-trash", variant: "danger", action: () => {} },
        ]}
      >
        <div class="ui-demo-context-target">Right click or press Shift+F10</div>
      </ContextMenu>
    </div>
  </DemoCard>
);

const SegmentedDemo = () => {
  const [value, setValue] = createSignal("week");
  return (
    <DemoCard
      id="segmented"
      chip={{ kind: "component", name: "SegmentedControl", from: "@k2b/ui" }}
      description="A full-width controlled radio group with dividers, wrapping arrow-key selection, Home/End navigation, and roving focus."
      code={`const [view, setView] = createSignal("week");

<SegmentedControl
  ariaLabel="Calendar view"
  value={view}
  onValueChange={setView}
  options={[
    { value: "day", label: "Day", icon: "ti ti-calendar" },
    { value: "week", label: "Week", icon: "ti ti-calendar-week" },
    { value: "month", label: "Month", icon: "ti ti-calendar-month" },
  ]}
/>`}
    >
      <SegmentedControl
        value={value}
        onValueChange={setValue}
        ariaLabel="Calendar view"
        options={[
          { value: "day", label: "Day", icon: "ti ti-calendar" },
          { value: "week", label: "Week", icon: "ti ti-calendar-week" },
          { value: "month", label: "Month", icon: "ti ti-calendar-month" },
        ]}
      />
    </DemoCard>
  );
};

const TabsDemo = () => {
  const [tab, setTab] = createSignal("overview");
  return (
    <DemoCard
      id="tabs"
      chip={{ kind: "component", name: "Tabs", from: "@k2b/ui" }}
      description="Tabs provide roving keyboard navigation and keep each trigger beside its panel content. The options prop remains available for data-driven tabs."
      code={`const [tab, setTab] = createSignal("overview");

<Tabs ariaLabel="Project sections" value={tab} onValueChange={setTab}>
  <Tabs.Item value="overview" label="Overview" icon="ti ti-layout-dashboard">
    <Overview />
  </Tabs.Item>
  <Tabs.Item value="activity" label="Activity" icon="ti ti-activity">
    <Activity />
  </Tabs.Item>
  <Tabs.Item value="archive" label="Archive" disabled>
    <Archive />
  </Tabs.Item>
</Tabs>`}
    >
      <Tabs ariaLabel="Project sections" value={tab} onValueChange={setTab}>
        <Tabs.Item value="overview" label="Overview" icon="ti ti-layout-dashboard">
          <p>Project summary and current health.</p>
        </Tabs.Item>
        <Tabs.Item value="activity" label="Activity" icon="ti ti-activity">
          <p>Recent changes across the project.</p>
        </Tabs.Item>
        <Tabs.Item value="archive" label="Archive" disabled>
          <p>Archived records.</p>
        </Tabs.Item>
      </Tabs>
    </DemoCard>
  );
};

const DisclosureDemo = () => {
  const [advanced, setAdvanced] = createSignal(false);
  return (
    <DemoCard
      id="disclosure"
      chip={{ kind: "component", name: "Disclosure", from: "@k2b/ui" }}
      description="Disclosure reveals optional detail with native details semantics and occupies only the height of its current content."
      code={`const [advanced, setAdvanced] = createSignal(false);

<Disclosure summary="Advanced settings" icon="ti ti-adjustments" value={advanced} onValueChange={setAdvanced}>
  Extra controls
</Disclosure>`}
    >
      <Disclosure summary="Advanced settings" icon="ti ti-adjustments" value={advanced} onValueChange={setAdvanced}>
        These controls stay collapsed until they are needed.
      </Disclosure>
    </DemoCard>
  );
};

const ToolbarDemo = () => (
  <DemoCard
    id="toolbar"
    chip={{ kind: "component", name: "Toolbar", from: "@k2b/ui" }}
    description="A semantic action row with named groups, separators, a flexible spacer, and optional wrapping. Buttons retain their own keyboard behavior."
    code={`<Toolbar label="Document actions" wrap>
  <Toolbar.Group label="History">
    <IconButton size="xs" label="Undo"><i class="ti ti-arrow-back-up" /></IconButton>
    <IconButton size="xs" label="Redo"><i class="ti ti-arrow-forward-up" /></IconButton>
  </Toolbar.Group>
  <Toolbar.Separator />
  <Button size="xs" variant="subtle"><i class="ti ti-activity" /> Status</Button>
  <Toolbar.Spacer />
  <Button size="sm">Publish</Button>
</Toolbar>`}
  >
    <Toolbar label="Document actions" wrap>
      <Toolbar.Group label="History">
        <IconButton size="xs" label="Undo">
          <i class="ti ti-arrow-back-up" aria-hidden="true" />
        </IconButton>
        <IconButton size="xs" label="Redo">
          <i class="ti ti-arrow-forward-up" aria-hidden="true" />
        </IconButton>
      </Toolbar.Group>
      <Toolbar.Separator />
      <Button size="xs" variant="subtle">
        <i class="ti ti-activity" aria-hidden="true" />
        Status
      </Button>
      <Toolbar.Spacer />
      <Button size="sm">Publish</Button>
    </Toolbar>
  </DemoCard>
);

export const FilterDemo = () => {
  const [clearValue, setClearValue] = createSignal<string[]>(["open", "ui"]);
  const [resetValue, setResetValue] = createSignal<string[]>(["done"]);
  const sections = [
    {
      label: "State",
      options: [
        { value: "open", label: "Open" },
        { value: "done", label: "Done" },
      ],
    },
    {
      label: "Tags",
      multiple: true,
      options: [
        { value: "ui", label: "UI", color: "#06b6d4" },
        { value: "api", label: "API", color: "#8b5cf6" },
      ],
    },
  ];
  return (
    <DemoCard
      id="filters"
      chip={{ kind: "component", name: "FilterChip", from: "@k2b/ui" }}
      description="Clear mode shows the selected count; a non-empty baseline hides the count and offers Reset when the selection differs."
      code={`<FilterChip
  label="Clear mode"
  icon="ti ti-filter"
  value={clearValue()}
  onValueChange={setClearValue}
  defaultValue={[]}
  options={sections}
/>

<FilterChip
  label="Baseline"
  icon="ti ti-filter"
  value={resetValue()}
  onValueChange={setResetValue}
  defaultValue={["open"]}
  options={sections}
/>`}
    >
      <div class="ui-demo-row">
        <FilterChip
          label="Clear mode"
          icon="ti ti-filter"
          value={clearValue()}
          onValueChange={setClearValue}
          defaultValue={[]}
          options={sections}
        />
        <FilterChip
          label="Baseline"
          icon="ti ti-filter"
          value={resetValue()}
          onValueChange={setResetValue}
          defaultValue={["open"]}
          options={sections}
        />
      </div>
    </DemoCard>
  );
};

const spotlightProjects = [
  { label: "Atlas", desc: "Customer portal", value: "atlas" },
  { label: "Beacon", desc: "Operations dashboard", value: "beacon" },
  { label: "Cedar", desc: "Documentation site", value: "cedar" },
];

const resolveSpotlightProjects: SpotlightSearchResolver<string> = ({ query }) => {
  const normalizedQuery = query.trim().toLowerCase();
  return spotlightProjects.filter((project) => `${project.label} ${project.desc}`.toLowerCase().includes(normalizedQuery));
};

const openSearch = async () => {
  await openSpotlightSearch<string>({
    title: "Open project",
    placeholder: "Search projects...",
    noResultsText: "No matching projects.",
    resolve: resolveSpotlightProjects,
  });
};

const SpotlightDemo = () => (
  <DemoCard
    id="spotlight"
    chip={{ kind: "component", name: "SpotlightButton", from: "@k2b/ui" }}
    description="Search launchers keep one shortcut contract while adapting to buttons, chips, sidebars, mobile navigation, and icon-only toolbars."
    code={`import {
  openSpotlightSearch,
  SpotlightButton,
  type SpotlightSearchResolver,
} from "@k2b/ui";

const spotlightProjects = [
  { label: "Atlas", desc: "Customer portal", value: "atlas" },
  { label: "Beacon", desc: "Operations dashboard", value: "beacon" },
  { label: "Cedar", desc: "Documentation site", value: "cedar" },
];

const resolveSpotlightProjects: SpotlightSearchResolver<string> = ({ query }) => {
  const normalizedQuery = query.trim().toLowerCase();
  return spotlightProjects.filter((project) =>
    \`\${project.label} \${project.desc}\`.toLowerCase().includes(normalizedQuery),
  );
};

const openSearch = async () => {
  await openSpotlightSearch<string>({
    title: "Open project",
    placeholder: "Search projects...",
    noResultsText: "No matching projects.",
    resolve: resolveSpotlightProjects,
  });
};

<SpotlightButton variant="default" onClick={openSearch} />
<SpotlightButton variant="chip" onClick={openSearch} />
<SpotlightButton variant="sidebar" onClick={openSearch} />
<SpotlightButton variant="sidebar-mobile" onClick={openSearch} />
<SpotlightButton variant="compact" onClick={openSearch} />
<SpotlightButton variant="icon" onClick={openSearch} />`}
  >
    <div class="ui-spotlight-demo">
      <section>
        <small>Page actions</small>
        <div class="ui-demo-row">
          <SpotlightButton variant="default" onClick={openSearch} />
          <SpotlightButton variant="chip" onClick={openSearch} />
        </div>
      </section>
      <section>
        <small>Sidebar</small>
        <div class="ui-spotlight-demo__sidebar">
          <SpotlightButton variant="sidebar" onClick={openSearch} />
        </div>
      </section>
      <section>
        <small>Mobile navigation</small>
        <div class="ui-spotlight-demo__mobile">
          <SpotlightButton variant="sidebar-mobile" onClick={openSearch} />
        </div>
      </section>
      <section>
        <small>Toolbar</small>
        <div class="ui-demo-row">
          <SpotlightButton variant="compact" onClick={openSearch} />
          <SpotlightButton variant="icon" onClick={openSearch} />
        </div>
      </section>
    </div>
  </DemoCard>
);

const demos: DemoSection = {
  buttons: () => (
    <DemoGrid columns="one">
      <ButtonsDemo />
    </DemoGrid>
  ),
  "copy-remove": () => (
    <DemoGrid columns="one">
      <CopyRemoveDemo />
    </DemoGrid>
  ),
  menus: () => (
    <DemoGrid columns="one">
      <MenusDemo />
    </DemoGrid>
  ),
  "segmented-control": () => (
    <DemoGrid columns="one">
      <SegmentedDemo />
    </DemoGrid>
  ),
  filters: () => (
    <DemoGrid columns="one">
      <FilterDemo />
    </DemoGrid>
  ),
  tabs: () => (
    <DemoGrid columns="one">
      <TabsDemo />
    </DemoGrid>
  ),
  disclosure: () => (
    <DemoGrid columns="one">
      <DisclosureDemo />
    </DemoGrid>
  ),
  toolbar: () => (
    <DemoGrid columns="one">
      <ToolbarDemo />
    </DemoGrid>
  ),
  spotlight: () => (
    <DemoGrid columns="one">
      <SpotlightDemo />
    </DemoGrid>
  ),
};

export default demos;
