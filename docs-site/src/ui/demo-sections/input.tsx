import {
  AutocompleteEditor,
  Checkbox,
  CheckboxCard,
  ColorInput,
  Combobox,
  type Completion,
  DatePicker,
  DateRangePicker,
  type DateRangeValue,
  DateTimePicker,
  FileDropzone,
  IconInput,
  ImageCropper,
  type ImageCropState,
  ImageInput,
  MarkdownEditor,
  MultiSelectInput,
  NumberInput,
  PinInput,
  Select,
  SelectChip,
  Slider,
  Switch,
  Tag,
  TagEditor,
  type TagEditorItem,
  TagsInput,
  TextInput,
} from "@k2b/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid, type DemoSection } from "./types";

const options = [
  {
    value: "platform",
    label: "Platform",
    description: "Runtime and infrastructure",
    icon: "ti ti-server",
    color: "#0891b2",
  },
  {
    value: "design",
    label: "Design system",
    description: "Product UI",
    icon: "ti ti-palette",
    color: "#8b5cf6",
  },
  {
    value: "docs",
    label: "Documentation",
    description: "Guides and references",
    icon: "ti ti-book",
    color: "#10b981",
  },
  {
    value: "archive",
    label: "Archive",
    description: "Unavailable in this workspace",
    icon: "ti ti-archive",
    disabled: true,
  },
];

const groupedOptions = [
  {
    value: "coffee",
    label: "Coffee",
    description: "Drinks and breaks",
    icon: "ti ti-coffee",
    groups: ["recommended", "food"],
  },
  {
    value: "pizza",
    label: "Pizza",
    description: "Meals and restaurants",
    icon: "ti ti-pizza",
    groups: ["food"],
  },
  {
    value: "briefcase",
    label: "Briefcase",
    description: "Projects and business",
    icon: "ti ti-briefcase",
    groups: ["recommended", "work"],
  },
  {
    value: "building",
    label: "Building",
    description: "Companies and offices",
    icon: "ti ti-building",
    groups: ["work"],
  },
  {
    value: "camera",
    label: "Camera",
    description: "Photos and visual media",
    icon: "ti ti-camera",
    groups: ["recommended", "media"],
  },
  {
    value: "music",
    label: "Music",
    description: "Audio and playlists",
    icon: "ti ti-music",
    groups: ["media"],
  },
];

const selectGroups = [
  { value: "recommended", label: "Recommended" },
  { value: "food", label: "Food" },
  { value: "work", label: "Work" },
  { value: "media", label: "Media" },
];

const people = [
  {
    id: "design",
    label: "Design team",
    description: "Product UI",
    hint: "team",
  },
  {
    id: "platform",
    label: "Platform team",
    description: "Runtime and infrastructure",
    hint: "team",
  },
  {
    id: "docs",
    label: "Documentation",
    description: "Guides and references",
    hint: "group",
  },
];

type CropAspectPreset = "square" | "wide" | "free";

const cropDemoSource = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
    <defs>
      <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
        <rect width="80" height="80" fill="#f8fafc"/>
        <path d="M80 0H0V80" fill="none" stroke="#cbd5e1" stroke-width="2"/>
        <path d="M0 80L80 0" stroke="#e2e8f0" stroke-width="2"/>
      </pattern>
    </defs>
    <rect width="800" height="500" fill="url(#grid)"/>
    <path d="M0 500L800 0" stroke="#0f172a" stroke-width="12" opacity=".18"/>
    <path d="M400 0V500M0 250H800" stroke="#64748b" stroke-width="4" stroke-dasharray="14 12"/>
    <rect x="52" y="52" width="190" height="112" rx="16" fill="#0891b2"/>
    <rect x="558" y="330" width="190" height="118" rx="16" fill="#7c3aed"/>
    <rect x="586" y="62" width="112" height="112" rx="16" fill="#f59e0b"/>
    <text x="147" y="120" text-anchor="middle" fill="white" font-family="sans-serif" font-size="28" font-weight="700">TOP LEFT</text>
    <text x="653" y="400" text-anchor="middle" fill="white" font-family="sans-serif" font-size="28" font-weight="700">BOTTOM</text>
    <text x="642" y="130" text-anchor="middle" fill="#422006" font-family="sans-serif" font-size="24" font-weight="700">90°</text>
  </svg>
`)}`;

const mentionCompletion: Completion = {
  trigger: "@",
  dropdown: true,
  knownLabels: people.map((person) => `@${person.id}`),
  suggest: (query) =>
    people
      .filter((person) => person.id.startsWith(query.toLowerCase()))
      .map((person) => ({
        text: `@${person.id}`,
        label: person.label,
        hint: person.hint,
      })),
};

const emojiCompletion: Completion = {
  trigger: ":",
  knownLabels: [":sparkles", ":rocket"],
  suggest: (query) =>
    [
      { text: ":sparkles", label: "sparkles", hint: "✨" },
      { text: ":rocket", label: "rocket", hint: "🚀" },
    ].filter((suggestion) => suggestion.text.slice(1).startsWith(query.toLowerCase())),
};

const TextDemo = () => {
  const [project, setProject] = createSignal("Portable value");
  const [token, setToken] = createSignal("secret");
  const [notes, setNotes] = createSignal("One focused multiline field.");
  const [prompt, setPrompt] = createSignal("Summarize this release");
  return (
    <DemoCard
      id="text"
      chip={{ kind: "component", name: "TextInput", from: "@k2b/ui" }}
      description="Accessor-controlled text, password, multiline, and AI-marked fields with shared labels, help, errors, native input hints, a shell-wide text cursor, and shell-wide browser autofill."
      code={`<TextInput label="Project" value={project} onValueChange={setProject} clearable icon="ti ti-folder" />
<TextInput label="Token" description="The package owns the reveal control." value={token} onValueChange={setToken} password icon="ti ti-lock" autocomplete="current-password" />
<TextInput label="Notes" value={notes} onValueChange={setNotes} multiline lines={3} icon="ti ti-notes" />
<TextInput label="AI prompt" value={prompt} onValueChange={setPrompt} variant="ai" />`}
    >
      <div class="ui-demo-form-grid">
        <TextInput label="Project" value={project} onValueChange={setProject} clearable icon="ti ti-folder" />
        <TextInput
          label="Token"
          value={token}
          onValueChange={setToken}
          password
          icon="ti ti-lock"
          autocomplete="current-password"
          description="The package owns the reveal control."
        />
        <TextInput label="Notes" value={notes} onValueChange={setNotes} multiline lines={3} icon="ti ti-notes" />
        <TextInput label="AI prompt" value={prompt} onValueChange={setPrompt} variant="ai" />
      </div>
    </DemoCard>
  );
};

const AutocompleteDemo = () => {
  const [value, setValue] = createSignal("Hello @de");
  return (
    <DemoCard
      id="autocomplete"
      chip={{
        kind: "component",
        name: "AutocompleteEditor",
        from: "@k2b/ui",
      }}
      description="A controlled textarea with width-neutral highlighting, ghost suggestions, accessible dropdown navigation, synchronous or abortable asynchronous completion, and native composition behavior."
      code={`<AutocompleteEditor
  label="Message"
  description="Type @de for a dropdown or :sp for a ghost suggestion."
  value={value()}
  onValueChange={setValue}
  completions={[mentionCompletion, emojiCompletion]}
  lines={5}
/>`}
    >
      <AutocompleteEditor
        label="Message"
        description="Type @de for a dropdown or :sp for a ghost suggestion. Tab accepts the active completion."
        value={value()}
        onValueChange={setValue}
        completions={[mentionCompletion, emojiCompletion]}
        lines={5}
      />
    </DemoCard>
  );
};

const MarkdownDemo = () => {
  const [value, setValue] = createSignal("# Release note\n\nAsk @de for review.\n\n- Portable\n- Accessible");
  const [saved, setSaved] = createSignal(false);
  return (
    <DemoCard
      id="markdown-editor"
      chip={{
        kind: "component",
        name: "MarkdownEditor",
        from: "@k2b/ui",
      }}
      description="Native textarea editing with a roving formatting toolbar, active format state, list continuation, smart URL paste, Markdown highlighting, statistics, save shortcuts, abbreviations, and accessible completions."
      code={`<MarkdownEditor
  label="Release note"
  description="Use the toolbar or keyboard shortcuts."
  value={value()}
  onValueChange={setValue}
  lines={8}
  abbreviations={{ afaik: "as far as I know" }}
  completions={[mentionCompletion]}
  onSave={save}
  toolbarTrailing={<span class="text-xs text-dimmed" role="status">{saved() ? "Saved" : "Unsaved"}</span>}
/>`}
    >
      <MarkdownEditor
        label="Release note"
        description="Use the toolbar or keyboard shortcuts. Type @de for suggestions."
        value={value()}
        onValueChange={(next) => {
          setValue(next);
          setSaved(false);
        }}
        lines={8}
        abbreviations={{ afaik: "as far as I know" }}
        completions={[mentionCompletion]}
        onSave={() => setSaved(true)}
        toolbarTrailing={
          <span class="text-xs text-dimmed" role="status" aria-live="polite">
            {saved() ? "Saved" : "Unsaved"}
          </span>
        }
      />
    </DemoCard>
  );
};

const NumberDemo = () => {
  const [budget, setBudget] = createSignal<number | null>(42.5);
  const [capacity, setCapacity] = createSignal<number | null>(64);
  const [count, setCount] = createSignal<number | null>(12);
  return (
    <DemoCard
      id="number"
      chip={{ kind: "component", name: "NumberInput", from: "@k2b/ui" }}
      description="Accessor-controlled numeric input with raw focused text, committed bounds, precision, steppers, units, and an explicit empty state."
      code={`<NumberInput
  label="Budget"
  value={budget}
  onValueChange={setBudget}
  prefix="€"
  suffix="gross"
  decimalPlaces={2}
  min={0}
  step={0.5}
  clearable
/>
<NumberInput label="Capacity" value={capacity} onValueChange={setCapacity} suffix="%" min={0} max={100} step={5} />
<NumberInput label="Workers" value={count} onValueChange={setCount} min={1} max={64} step={1} />`}
    >
      <div class="ui-demo-form-grid">
        <NumberInput
          label="Budget"
          value={budget}
          onValueChange={setBudget}
          prefix="€"
          suffix="gross"
          decimalPlaces={2}
          min={0}
          step={0.5}
          clearable
        />
        <NumberInput
          label="Capacity"
          value={capacity}
          onValueChange={setCapacity}
          suffix="%"
          min={0}
          max={100}
          step={5}
        />
        <NumberInput
          label="Workers"
          value={count}
          onValueChange={setCount}
          min={1}
          max={64}
          step={1}
        />
      </div>
    </DemoCard>
  );
};

const DateDemo = () => {
  const [date, setDate] = createSignal<string | null>("2026-07-28");
  const [dateTime, setDateTime] = createSignal<string | null>("2026-07-28T09:30");
  const [range, setRange] = createSignal<DateRangeValue>({
    start: "2026-07-28",
    end: "2026-07-31",
  });
  const [dateTimeRange, setDateTimeRange] = createSignal<DateRangeValue>({
    start: "2026-07-28T09:00",
    end: "2026-07-28T10:00",
  });
  return (
    <DemoCard
      id="date-picker"
      chip={[
        { kind: "component", name: "DatePicker", from: "@k2b/ui" },
        { kind: "component", name: "DateTimePicker", from: "@k2b/ui" },
        { kind: "component", name: "DateRangePicker", from: "@k2b/ui" },
      ]}
      description="Date, date-time, and range pickers share one controlled, timezone-aware calendar interaction with clear and preset support."
      code={`<DatePicker label="Release date" value={date()} onValueChange={setDate} clearable />
<DateTimePicker label="Starts at" value={dateTime()} onValueChange={setDateTime} dateConfig={dateConfig} />
<DateRangePicker label="Window" value={range()} onValueChange={setRange} presets={datePresets} />
<DateRangePicker
  label="Meeting window"
  value={dateTimeRange()}
  onValueChange={setDateTimeRange}
  withTime
  dateConfig={dateConfig}
  datePresets={datePresets}
  durationPresets={durationPresets}
/>`}
    >
      <div class="ui-demo-form-grid">
        <DatePicker label="Release date" value={date()} onValueChange={setDate} clearable />
        <DateTimePicker
          label="Starts at"
          value={dateTime()}
          onValueChange={setDateTime}
          dateConfig={{ timeZone: "Europe/Berlin", weekStartsOn: 1 }}
        />
        <DateRangePicker
          label="Window"
          value={range()}
          onValueChange={setRange}
          presets={[
            {
              label: "Release week",
              value: { start: "2026-07-28", end: "2026-07-31" },
            },
            {
              label: "This month",
              value: { start: "2026-07-01", end: "2026-07-31" },
            },
            {
              label: "Next 30 days",
              value: { start: "2026-07-28", end: "2026-08-26" },
            },
          ]}
        />
        <DateRangePicker
          label="Meeting window"
          value={dateTimeRange()}
          onValueChange={setDateTimeRange}
          withTime
          dateConfig={{ timeZone: "Europe/Berlin", weekStartsOn: 1 }}
          datePresets={[
            { label: "Today", value: "2026-07-28" },
            { label: "Tomorrow", value: "2026-07-29" },
            { label: "Next Monday", value: "2026-08-03" },
          ]}
          durationPresets={[
            { label: "30 min", minutes: 30 },
            { label: "1 hour", minutes: 60 },
            { label: "2 hours", minutes: 120 },
            { label: "Half day", minutes: 240 },
          ]}
        />
      </div>
    </DemoCard>
  );
};

const SelectDemo = () => {
  const [value, setValue] = createSignal("platform");
  const [many, setMany] = createSignal(["platform"]);
  const [chip, setChip] = createSignal("week");
  return (
    <DemoCard
      id="select"
      chip={[
        { kind: "component", name: "Select", from: "@k2b/ui" },
        { kind: "component", name: "MultiSelectInput", from: "@k2b/ui" },
        { kind: "component", name: "SelectChip", from: "@k2b/ui" },
      ]}
      description="Select filters its static options only when searchable is set; MultiSelectInput renders its search field by default. An option color replaces the icon with a dot in Select, and tints the icon and selected pill in MultiSelectInput. SelectChip is the compact form: a 10rem menu with a trailing check marker."
      code={`<Select label="Team" description="Type to filter the static options." value={team} options={options} onValueChange={setTeam} searchable clearable />

{/* MultiSelectInput always renders its search field */}
<MultiSelectInput label="Teams" value={teams} onValueChange={setTeams} options={options} clearable />

<Select label="Team (no search)" value={team} onValueChange={setTeam} options={options} />

<SelectChip aria-label="Range" value={range()} onValueChange={setRange} icon="ti ti-calendar" options={rangeOptions} />`}
    >
      <div class="ui-demo-form-grid">
        <Select
          label="Team"
          description="Type in the search field to filter the four static options."
          value={value}
          onValueChange={setValue}
          options={options}
          searchable
          clearable
        />
        <MultiSelectInput label="Teams" value={many} onValueChange={setMany} options={options} clearable />
        <Select label="Team (no search)" value={value} onValueChange={setValue} options={options} />
        <SelectChip
          aria-label="Range"
          value={chip()}
          onValueChange={setChip}
          icon="ti ti-calendar"
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
      </div>
    </DemoCard>
  );
};

const GroupedSelectDemo = () => {
  const [value, setValue] = createSignal("briefcase");
  return (
    <DemoCard
      id="select-groups"
      chip={{ kind: "component", name: "Select", from: "@k2b/ui" }}
      description="Optional group chips narrow one option list without partitioning it. Options may belong to several groups; text search stays inside the active group, and All removes the group filter."
      code={`<Select
  label="Icon"
  value={icon}
  onValueChange={setIcon}
  options={options}
  groups={[
    { value: "recommended", label: "Recommended" },
    { value: "food", label: "Food" },
    { value: "work", label: "Work" },
  ]}
  defaultGroup="recommended"
  searchable
/>`}
    >
      <Select
        label="Icon"
        description="Search the active group or switch groups to narrow the catalogue."
        value={value}
        onValueChange={setValue}
        options={groupedOptions}
        groups={selectGroups}
        defaultGroup="recommended"
        searchable
        clearable
      />
    </DemoCard>
  );
};

const ComboboxDemo = () => (
  <DemoCard
    id="combobox"
    chip={{ kind: "component", name: "Combobox", from: "@k2b/ui" }}
    description="An asynchronous consume-and-clear search for commands or entities, with abortable loading, retry state, keyboard navigation, and focus restoration."
    code={`<Combobox label="Team" placeholder="Add team" fetchData={searchTeams} onSelect={addTeam} />`}
  >
    <Combobox
      label="Team"
      placeholder="Search teams to add…"
      fetchData={async (query) =>
        people
          .filter((person) => person.label.toLowerCase().includes(query.toLowerCase()))
          .map((person) => ({
            id: person.id,
            label: person.label,
            description: person.description,
          }))
      }
      onSelect={() => {}}
    />
  </DemoCard>
);

const TagEditorDemo = () => {
  const [items, setItems] = createSignal<TagEditorItem[]>([
    { id: "platform", name: "Platform", color: "#0891b2" },
    { id: "design", name: "Design", color: "#8b5cf6" },
  ]);
  const [selected, setSelected] = createSignal(["platform"]);
  let nextId = 1;
  return (
    <DemoCard
      id="tag-editor"
      chip={[
        { kind: "component", name: "Tag", from: "@k2b/ui" },
        { kind: "component", name: "TagEditor", from: "@k2b/ui" },
        { kind: "component", name: "MultiSelectInput", from: "@k2b/ui" },
      ]}
      description="Tag owns compact presentation; TagEditor owns accessible create/edit/delete interaction while the application owns persistence and confirmation. MultiSelectInput assigns existing tags and accepts custom option/value rendering."
      code={`const [tags, setTags] = createSignal<TagEditorItem[]>(initialTags);

<Tag color="#0891b2">Platform</Tag>
<Tag color="#8b5cf6" icon="ti ti-palette">Design</Tag>
<Tag size="sm">Neutral</Tag>
<Tag color="#2563eb" icon="ti ti-point" selected size="lg">Selected</Tag>

<TagEditor
  items={tags()}
  onCreate={async (value) => setTags((items) => [...items, { id: crypto.randomUUID(), ...value }])}
  onUpdate={async (tag, value) => setTags((items) => items.map((item) => item.id === tag.id ? { ...item, ...value } : item))}
  onDelete={async (tag) => setTags((items) => items.filter((item) => item.id !== tag.id))}
/>

<MultiSelectInput
  label="Assigned tags"
  value={selected}
  onValueChange={setSelected}
  options={tags().map((tag) => ({ value: tag.id, label: tag.name, color: tag.color }))}
  renderValue={(option) => <strong>{option.label}</strong>}
  renderOption={(option) => <TagOption option={option} />}
  searchPlaceholder="Search tags..."
  emptyLabel="No tags available"
  noResultsLabel="No matching tags"
  clearable
/>`}
    >
      <div class="ui-demo-form-grid">
        <div class="ui-demo-row">
          <Tag color="#0891b2">Platform</Tag>
          <Tag color="#8b5cf6" icon="ti ti-palette">Design</Tag>
          <Tag size="sm">Neutral</Tag>
          <Tag color="#2563eb" icon="ti ti-point" selected size="lg">
            Selected
          </Tag>
        </div>
        <TagEditor
          items={items()}
          onCreate={async (value) => { setItems((current) => [...current, { id: `tag-${nextId++}`, ...value }]); }}
          onUpdate={async (tag, value) => { setItems((current) => current.map((item) => item.id === tag.id ? { ...item, ...value } : item)); }}
          onDelete={async (tag) => {
            setItems((current) => current.filter((item) => item.id !== tag.id));
            setSelected((current) => current.filter((id) => id !== tag.id));
          }}
        />
        <MultiSelectInput
          label="Assigned tags"
          value={selected}
          onValueChange={setSelected}
          options={items().map((tag) => ({ value: tag.id, label: tag.name, color: tag.color ?? undefined }))}
          renderValue={(option) => <strong>{option.label}</strong>}
          renderOption={(option) => <span class="ui-demo-choice-copy"><strong>{option.label}</strong><small>Reusable project tag</small></span>}
          searchPlaceholder="Search tags..."
          emptyLabel="No tags available"
          noResultsLabel="No matching tags"
          clearable
        />
      </div>
    </DemoCard>
  );
};

const SmallChoicesDemo = (props: { kind: "color" | "tags" | "pin" | "icon" | "slider" }) => {
  const [color, setColor] = createSignal("#06b6d4");
  const [transparent, setTransparent] = createSignal(false);
  const [tags, setTags] = createSignal(["solid", "ssr"]);
  const [pin, setPin] = createSignal("2607");
  const [icon, setIcon] = createSignal<string | null>("ti ti-cube");
  const [slider, setSlider] = createSignal(64);
  const component = () => {
    if (props.kind === "color") {
      return (
        <ColorInput
          label="Accent"
          value={color}
          onValueChange={setColor}
          transparent
          transparentValue={transparent}
          onTransparentValueChange={setTransparent}
        />
      );
    }
    if (props.kind === "tags") {
      return (
        <TagsInput
          label="Tags"
          description="Focus the field to edit the comma-separated text. Enter or blur commits: entries are trimmed, deduplicated, and capped at maxTags."
          value={tags}
          onValueChange={setTags}
          maxTags={5}
        />
      );
    }
    if (props.kind === "pin") {
      return <PinInput label="Verification code" value={pin} onValueChange={setPin} length={6} stretch />;
    }
    if (props.kind === "icon") {
      return (
        <IconInput
          label="Icon"
          description="Browse recommendations or narrow the catalogue by topic. Search also matches common synonyms."
          value={icon()}
          onValueChange={setIcon}
        />
      );
    }
    return (
      <Slider
        label="Capacity"
        value={slider}
        onValueChange={setSlider}
        min={0}
        max={100}
        formatValue={(value) => `${value}%`}
        defaultValue={50}
      />
    );
  };
  const names = {
    color: "ColorInput",
    tags: "TagsInput",
    pin: "PinInput",
    icon: "IconInput",
    slider: "Slider",
  };
  const snippets = {
    color: `<ColorInput
  label="Accent"
  value={color}
  onValueChange={setColor}
  transparent
  transparentValue={transparent}
  onTransparentValueChange={setTransparent}
/>`,
    tags: `<TagsInput label="Tags" value={tags} onValueChange={setTags} maxTags={5} />`,
    pin: `<PinInput label="Verification code" value={pin} onValueChange={setPin} length={6} stretch />`,
    icon: `<IconInput
  label="Icon"
  description="Browse recommendations or narrow the catalogue by topic."
  value={icon()}
  onValueChange={setIcon}
/>`,
    slider: `<Slider
  label="Capacity"
  value={slider}
  onValueChange={setSlider}
  min={0}
  max={100}
  defaultValue={50}
  formatValue={(value) => \`\${value}%\`}
/>`,
  };
  const descriptions = {
    color: "A native color well plus an optional transparent toggle the parent owns as a separate boolean.",
    tags: "One native text field holding a comma-separated list. Typing reports live values; blur or Enter commits once, trims entries, drops duplicates, applies maxTags, and announces the diff to assistive technology.",
    pin: "Grouped one-time-code entry with per-cell arrow-key navigation, backspace stepping, and paste distribution across the cells.",
    icon: "Searchable icon selection over the grouped default catalogue. Each option explains its intended use, and one icon may appear in several topics.",
    slider: "A native range input with a filled track, a formatted value output, and a double-click reset to defaultValue.",
  };
  return (
    <DemoCard
      id={props.kind}
      chip={{
        kind: "component",
        name: names[props.kind],
        from: "@k2b/ui",
      }}
      description={descriptions[props.kind]}
      code={snippets[props.kind]}
    >
      {component()}
    </DemoCard>
  );
};

const FileDemo = (props: { image?: boolean }) => {
  const [image, setImage] = createSignal<string | null>(null);
  const [lastFile, setLastFile] = createSignal("");
  return (
    <DemoCard
      id={props.image ? "image" : "file-dropzone"}
      chip={{
        kind: "component",
        name: props.image ? "ImageInput" : "FileDropzone",
        from: "@k2b/ui",
      }}
      description="The package owns file selection and accessible interaction state; validation, upload, persistence, and transformed image ownership stay with the application."
      code={
        props.image
          ? `<ImageInput label="Avatar" value={image} onValueChange={setImage} round />
<ImageInput aria-label="Compact logo" value={image} onValueChange={setImage} variant="small" />`
          : `<FileDropzone
  label="Attachment"
  accept="image/*"
  multiple={false}
  subtitle="PNG, JPG, or WebP"
  hint={lastFile() ? \`Selected \${lastFile()}\` : "One image"}
  onDrop={upload}
/>`
      }
    >
      {props.image ? (
        <>
          <ImageInput
            label="Avatar"
            description="Square WebP preview with replace and remove actions."
            value={image}
            onValueChange={setImage}
            round
          />
          <ImageInput aria-label="Compact logo" value={image} onValueChange={setImage} variant="small" />
        </>
      ) : (
        <FileDropzone
          label="Attachment"
          accept="image/*"
          multiple={false}
          subtitle="PNG, JPG, or WebP"
          hint={lastFile() ? `Selected ${lastFile()}` : "One image"}
          onDrop={(files) => {
            setLastFile(files[0]?.name ?? "");
          }}
        />
      )}
    </DemoCard>
  );
};

const CropDemo = () => {
  const [, setCrop] = createSignal<ImageCropState | null>(null);
  const [aspect, setAspect] = createSignal<CropAspectPreset>("square");
  const cropAspect = () =>
    aspect() === "square" ? { width: 1, height: 1 } : aspect() === "wide" ? { width: 16, height: 9 } : "free";
  return (
    <DemoCard
      id="image-cropper"
      chip={{ kind: "component", name: "ImageCropper", from: "@k2b/ui" }}
      description="Interactive crop, direct corner resize, and rotation over an application-owned image source; fixed aspect ratios stay locked while resizing."
      code={`const cropAspect = () => preset() === "square"
  ? { width: 1, height: 1 }
  : preset() === "wide"
    ? { width: 16, height: 9 }
    : "free";

<Select label="Aspect" value={preset} onValueChange={setPreset} options={aspectOptions} />
<ImageCropper source={imageUrl} aspect={cropAspect()} previewShape="rect" onValueChange={setCrop} />`}
    >
      <div class="ui-crop-demo">
        <Select
          label="Aspect ratio"
          value={aspect}
          onValueChange={(id) => {
            setAspect((id as CropAspectPreset | null) ?? "square");
            setCrop(null);
          }}
          options={[
            { id: "square", label: "Square", icon: "ti ti-crop-1-1" },
            { id: "wide", label: "16:9", icon: "ti ti-aspect-ratio" },
            { id: "free", label: "Free", icon: "ti ti-crop" },
          ]}
        />
        <ImageCropper
          source={cropDemoSource}
          aspect={cropAspect()}
          previewShape="rect"
          onValueChange={setCrop}
        />
      </div>
    </DemoCard>
  );
};

const BooleanDemo = () => {
  const [enabled, setEnabled] = createSignal(true);
  const [checked, setChecked] = createSignal(false);
  return (
    <DemoCard
      id="boolean"
      chip={[
        { kind: "component", name: "Switch", from: "@k2b/ui" },
        { kind: "component", name: "Checkbox", from: "@k2b/ui" },
        { kind: "component", name: "CheckboxCard", from: "@k2b/ui" },
      ]}
      description="Native checkbox semantics wrapped in three accessor-controlled presentations for immediate settings, form choices, and descriptive cards."
      code={`<Switch label="Automation" value={enabled} onValueChange={setEnabled} />
<Checkbox label="Send a summary" description="Notify everyone when the run finishes." value={checked} onValueChange={setChecked} />
<CheckboxCard label="Early access" description="Preview new components." icon="ti ti-flask" value={checked} onValueChange={setChecked} />`}
    >
      <div class="ui-demo-form-grid">
        <Switch label="Automation" value={enabled} onValueChange={setEnabled} />
        <Checkbox label="Send a summary" description="Notify everyone when the run finishes." value={checked} onValueChange={setChecked} />
        <CheckboxCard label="Early access" description="Preview new components." icon="ti ti-flask" value={checked} onValueChange={setChecked} />
      </div>
    </DemoCard>
  );
};

const demos: DemoSection = {
  text: () => (
    <DemoGrid columns="one">
      <TextDemo />
    </DemoGrid>
  ),
  "markdown-editor": () => (
    <DemoGrid columns="one">
      <MarkdownDemo />
    </DemoGrid>
  ),
  autocomplete: () => (
    <DemoGrid columns="one">
      <AutocompleteDemo />
    </DemoGrid>
  ),
  number: () => (
    <DemoGrid columns="one">
      <NumberDemo />
    </DemoGrid>
  ),
  "date-picker": () => (
    <DemoGrid columns="one">
      <DateDemo />
    </DemoGrid>
  ),
  select: () => (
    <DemoGrid columns="one">
      <SelectDemo />
      <GroupedSelectDemo />
    </DemoGrid>
  ),
  combobox: () => (
    <DemoGrid columns="one">
      <ComboboxDemo />
    </DemoGrid>
  ),
  color: () => (
    <DemoGrid columns="one">
      <SmallChoicesDemo kind="color" />
    </DemoGrid>
  ),
  tags: () => (
    <DemoGrid columns="one">
      <SmallChoicesDemo kind="tags" />
    </DemoGrid>
  ),
  "tag-editor": () => (
    <DemoGrid columns="one">
      <TagEditorDemo />
    </DemoGrid>
  ),
  pin: () => (
    <DemoGrid columns="one">
      <SmallChoicesDemo kind="pin" />
    </DemoGrid>
  ),
  image: () => (
    <DemoGrid columns="one">
      <FileDemo image />
    </DemoGrid>
  ),
  "image-cropper": () => (
    <DemoGrid columns="one">
      <CropDemo />
    </DemoGrid>
  ),
  "file-dropzone": () => (
    <DemoGrid columns="one">
      <FileDemo />
    </DemoGrid>
  ),
  icon: () => (
    <DemoGrid columns="one">
      <SmallChoicesDemo kind="icon" />
    </DemoGrid>
  ),
  slider: () => (
    <DemoGrid columns="one">
      <SmallChoicesDemo kind="slider" />
    </DemoGrid>
  ),
  boolean: () => (
    <DemoGrid columns="one">
      <BooleanDemo />
    </DemoGrid>
  ),
};

export default demos;
