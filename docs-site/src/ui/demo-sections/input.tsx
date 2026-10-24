import { fuzzy } from "@k2b/stdlib";
import {
  AutocompleteEditor,
  AutocompleteSelect,
  type AutocompleteSelectOption,
  type AutocompleteSelectSearchResult,
  Button,
  Checkbox,
  CheckboxCard,
  ChoiceChips,
  ChoiceTiles,
  ColorChoices,
  ColorInput,
  Combobox,
  type Completion,
  DatePicker,
  DateRangePicker,
  type DateRangeValue,
  DateTimePicker,
  EmojiPicker,
  type EmojiSkinTone,
  FileDropTarget,
  FileDropzone,
  fileDropTarget,
  highlightSql,
  IconInput,
  ImageCropper,
  type ImageCropState,
  ImageInput,
  MarkdownEditor,
  MultiSelectInput,
  NumberInput,
  PinInput,
  RichSelect,
  type RichSelectFact,
  RichSelectFacts,
  type RichSelectItem,
  type RichSelectStatus,
  rememberEmoji,
  SegmentedControl,
  Select,
  SelectChip,
  SignatureInput,
  type SignatureValue,
  Slider,
  Switch,
  signatureToPng,
  Tag,
  TagEditor,
  type TagEditorItem,
  TagsInput,
  TextInput,
} from "@k2b/ui";
import { createSignal, createUniqueId } from "solid-js";
import { DemoCard } from "../DemoCard";
import { QrScannerDemo } from "./mobile-navigation";
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

const artCategories: readonly AutocompleteSelectOption[] = [
  { value: "551", label: "Gemälde", description: "Kunst > Malerei > Gemälde", icon: "ti ti-brush", groups: ["recommended", "fine-art"] },
  { value: "553", label: "Zeichnungen", description: "Kunst > Grafik > Zeichnungen", icon: "ti ti-pencil", groups: ["fine-art"] },
  {
    value: "557",
    label: "Druckgrafik",
    description: "Kunst > Grafik > Druckgrafik",
    icon: "ti ti-printer",
    groups: ["recommended", "fine-art"],
  },
  { value: "619", label: "Skulpturen", description: "Kunst > Plastik > Skulpturen", icon: "ti ti-building-monument", groups: ["fine-art"] },
  { value: "870", label: "Fotografie", description: "Kunst > Fotografie", icon: "ti ti-camera", groups: ["recommended", "media"] },
  { value: "901", label: "Textilien", description: "Kunsthandwerk > Textilien", icon: "ti ti-shirt", groups: ["craft"] },
];

const artCategoryGroups = [
  { value: "recommended", label: "Recommended" },
  { value: "fine-art", label: "Fine art" },
  { value: "media", label: "Media" },
  { value: "craft", label: "Craft" },
];

const normalizeCategoryQuery = (query: string) => query.trim().toLocaleLowerCase();

const categoryMatch = (query: string, options = artCategories): AutocompleteSelectOption | undefined => {
  const normalized = normalizeCategoryQuery(query);
  if (!normalized) return undefined;
  const exact = options.find(
    (option) => option.value.toLocaleLowerCase() === normalized || option.label.toLocaleLowerCase() === normalized,
  );
  if (exact) return exact;
  const prefixes = options.filter(
    (option) => option.value.toLocaleLowerCase().startsWith(normalized) || option.label.toLocaleLowerCase().startsWith(normalized),
  );
  return prefixes.length === 1 ? prefixes[0] : undefined;
};

const waitForCategorySearch = (signal: AbortSignal, milliseconds = 180) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Search aborted", "AbortError"));
      },
      { once: true },
    );
  });

const findArtCategories = (query: string, group: string | null = null): AutocompleteSelectSearchResult => {
  const normalized = normalizeCategoryQuery(query);
  const grouped = group ? artCategories.filter((option) => option.groups?.includes(group)) : artCategories;
  const options = normalized
    ? fuzzy
        .filter(normalized, grouped, {
          key: (option) => `${option.value} ${option.label} ${option.description ?? ""}`,
          limit: 6,
        })
        .map((hit) => hit.item)
    : grouped;
  return { options, match: categoryMatch(query, grouped) };
};

const searchArtCategories = async (
  query: string,
  signal: AbortSignal,
  group: string | null = null,
): Promise<AutocompleteSelectSearchResult> => {
  await waitForCategorySearch(signal);
  return findArtCategories(query, group);
};

const searchArtCategoriesImmediately = async (
  query: string,
  signal: AbortSignal,
  group: string | null = null,
): Promise<AutocompleteSelectSearchResult> => {
  if (signal.aborted) throw new DOMException("Search aborted", "AbortError");
  return findArtCategories(query, group);
};

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
  const externalErrorId = createUniqueId();
  const [project, setProject] = createSignal("Portable value");
  const [amountText, setAmountText] = createSignal("1933.30");
  const [expiresAt, setExpiresAt] = createSignal("");
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
<TextInput label="AI prompt" value={prompt} onValueChange={setPrompt} variant="ai" />
<TextInput variant="compact" aria-label="Region" prefix=":region" value="" error="Enter a region before continuing." externalErrorId={externalErrorId} />
<p id={externalErrorId} role="status">Enter a region before continuing.</p>
<TextInput label="Expiry (placeholder)" value={expiresAt} onValueChange={setExpiresAt} placeholder="2027-01-01T00:00:00Z" icon="ti ti-calendar" />
<TextInput label="Expiry (entered value)" value="2027-01-01T00:00:00Z" icon="ti ti-calendar" />
<TextInput label="Amount text" value={amountText} onValueChange={setAmountText} icon="ti ti-number" suffix="EUR" inputMode="decimal" />
<TextInput label="Clearable amount text" value={amountText} onValueChange={setAmountText} icon="ti ti-number" suffix="EUR" inputMode="decimal" clearable />`}
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
        <TextInput variant="compact" aria-label="Region" prefix=":region" value="Europe" monospace />
        <TextInput variant="compact" aria-label="Inline error example" prefix=":region" value="" error="Enter a region." />
        <div>
          <TextInput
            variant="compact"
            aria-label="External error example"
            prefix=":region"
            value=""
            error="Enter a region before continuing."
            externalErrorId={externalErrorId}
          />
          <p id={externalErrorId} role="status">
            Enter a region before continuing.
          </p>
        </div>
        <TextInput
          label="Expiry (placeholder)"
          value={expiresAt}
          onValueChange={setExpiresAt}
          placeholder="2027-01-01T00:00:00Z"
          icon="ti ti-calendar"
        />
        <TextInput label="Expiry (entered value)" value="2027-01-01T00:00:00Z" icon="ti ti-calendar" />
        <TextInput
          label="Amount text"
          value={amountText}
          onValueChange={setAmountText}
          icon="ti ti-number"
          suffix="EUR"
          inputMode="decimal"
        />
        <TextInput
          label="Clearable amount text"
          value={amountText}
          onValueChange={setAmountText}
          icon="ti ti-number"
          suffix="EUR"
          inputMode="decimal"
          clearable
        />
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
      <AutocompleteEditor
        label="SQL with a marked line"
        value={"SELECT :host, count()\nFROM events\nGROUP BY host"}
        highlight={highlightSql}
        lineNumbers
        markedLine={2}
        lines={5}
      />
      <div class="h-[232px] rounded-xl bg-(--k2b-surface-muted) text-[13px] leading-5 focus-within:outline-2 focus-within:outline-(--k2b-action)">
        <AutocompleteEditor
          variant="embedded"
          fill
          lineNumbers
          readOnly
          aria-label="Embedded read-only query"
          value={"SELECT :region\nFROM events"}
          highlight={highlightSql}
        />
      </div>
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

const moveTargets: RichSelectItem[] = [
  { value: "review", label: "Marketing · Review", color: "#8b5cf6", description: "2 tags are dropped" },
  { value: "print", label: "Print orders · Inbox", color: "#f97316", description: "A guest can see it, one assignee is dropped" },
  { value: "archive", label: "Archive 2026 · Done", color: "#64748b", description: "Nothing is dropped" },
  { value: "support", label: "Support · Backlog", color: "#0ea5e9", disabledReason: "No write access" },
];
const moveFacts: Record<string, readonly RichSelectFact[]> = {
  review: [
    { icon: "ti ti-users", text: "Visible to 8 members" },
    { icon: "ti ti-tag-off", text: "The tags “Print” and “Q4” are dropped", tone: "warning" },
    { icon: "ti ti-paperclip", text: "Comments and attachments move along" },
  ],
  print: [
    { icon: "ti ti-eye", text: "A guest can see this card", tone: "warning" },
    { icon: "ti ti-user-minus", text: "One assignee is dropped", tone: "warning" },
    { icon: "ti ti-tag-off", text: "The tags “Print” and “Q4” are dropped", tone: "warning" },
  ],
  archive: [
    { icon: "ti ti-check", text: "Nothing is dropped" },
    { icon: "ti ti-users", text: "Visible to archive members" },
    { icon: "ti ti-paperclip", text: "Comments and attachments move along" },
  ],
  support: [
    { icon: "ti ti-lock", text: "You need write access to move a card here", tone: "warning" },
    { icon: "ti ti-users", text: "Ask a Support manager to grant you write access" },
  ],
};
const senderItems: RichSelectItem[] = [
  { value: "mara", label: "Mara Example", description: "mara@example.com" },
  { value: "support", label: "Support team", description: "support@example.com" },
  { value: "invoices", label: "Invoices", description: "invoices@example.com" },
  { value: "info", label: "info@example.com", disabledReason: "Not enabled yet" },
];
const senderFacts: Record<string, readonly RichSelectFact[]> = {
  mara: [
    { icon: "ti ti-signature", text: "Mara's personal signature" },
    { icon: "ti ti-eye", text: "Only Mara sees the sent mail" },
    { icon: "ti ti-arrow-back", text: "Replies go to mara@example.com" },
  ],
  support: [
    { icon: "ti ti-signature", text: "Support team signature" },
    { icon: "ti ti-eye", text: "The support team sees the sent mail; a copy goes to the ticket system" },
    { icon: "ti ti-arrow-back", text: "Replies go to support@example.com" },
  ],
  invoices: [
    { icon: "ti ti-signature", text: "Billing signature with payment details" },
    { icon: "ti ti-eye", text: "The billing team sees the sent mail" },
    { icon: "ti ti-arrow-back", text: "Replies go to accounts@example.com" },
  ],
  info: [
    { icon: "ti ti-lock", text: "This sender is not enabled yet", tone: "warning" },
    { icon: "ti ti-settings", text: "Ask an administrator to enable info@example.com" },
  ],
};
const sharingItems: RichSelectItem[] = [
  { value: "view", label: "View", description: "Read content", disabledReason: "You are the last manager" },
  { value: "edit", label: "Edit", description: "Change content", disabledReason: "You are the last manager" },
  { value: "manage", label: "Manage", description: "Also members, settings and deleting" },
];

const RichSelectDemo = () => {
  const [state, setState] = createSignal<"normal" | "loading" | "error" | "empty" | "noperm">("normal");
  const [sender, setSender] = createSignal<string | null>("mara");
  const [access, setAccess] = createSignal<string | null>("manage");
  const [movedTo, setMovedTo] = createSignal<string>();
  const status = (): RichSelectStatus => (state() === "loading" ? "loading" : state() === "error" ? "error" : "ready");
  const reset = () => setState("normal");
  const selectedSender = () => senderItems.find((item) => item.value === sender());
  // Without permission every option except the one that stays possible shows why it cannot be chosen.
  const shown = (items: RichSelectItem[], keep: string | null, reason: string) =>
    state() === "empty"
      ? []
      : state() === "noperm"
        ? items.map((item) => (item.value === keep ? item : { ...item, disabledReason: reason }))
        : items;
  return (
    <DemoGrid>
      <SegmentedControl
        ariaLabel="Picker state"
        value={state}
        onValueChange={setState}
        options={[
          { value: "normal", label: "Normal" },
          { value: "loading", label: "Loading" },
          { value: "error", label: "Error" },
          { value: "empty", label: "Empty" },
          { value: "noperm", label: "No permission" },
        ]}
      />
      <DemoCard
        id="rich-select-move"
        chip={[
          { kind: "component", name: "RichSelect", from: "@k2b/ui" },
          { kind: "component", name: "RichSelectFacts", from: "@k2b/ui" },
        ]}
        description="Move card: compare access, lost tags, and assignees. This action picker keeps its empty value; the demo reports the destination without moving a real card."
        code={`<RichSelect
  label="Move card"
  placeholder="Move to …"
  value={null}
  onValueChange={moveCard}
  items={moveTargets}
  status={status()}
  onRetry={retry}
  empty="No targets are set up for this space."
  renderPreview={(item) => <RichSelectFacts facts={moveFacts[item.value] ?? []} />}
/>`}
      >
        <RichSelect
          label="Move card"
          title="Move card"
          placeholder="Move to …"
          value={null}
          onValueChange={setMovedTo}
          items={shown(moveTargets, "archive", "No write access")}
          status={status()}
          onRetry={reset}
          empty="No targets are set up for this space."
          renderPreview={(item) => <RichSelectFacts facts={moveFacts[item.value] ?? []} />}
        />
        <p role="status" aria-live="polite">
          {movedTo()
            ? `Demo destination: ${moveTargets.find((item) => item.value === movedTo())?.label}`
            : "Choose a destination to try the action."}
        </p>
      </DemoCard>
      <DemoCard
        id="rich-select-sender"
        chip={{ kind: "component", name: "RichSelect", from: "@k2b/ui" }}
        description="Send as: sender identity changes the signature, sent-mail visibility, copies, and replies."
        code={`<RichSelect
  label="Send as"
  value={sender}
  onValueChange={setSender}
  triggerLabel={selectedSender() ? \`\${selectedSender()?.label} · \${selectedSender()?.description}\` : undefined}
  items={senderItems}
  renderPreview={(item) => <RichSelectFacts facts={senderFacts[item.value] ?? []} />}
/>`}
      >
        <RichSelect
          label="Send as"
          title="Send as"
          value={sender}
          onValueChange={setSender}
          triggerLabel={selectedSender() ? `${selectedSender()?.label} · ${selectedSender()?.description}` : undefined}
          items={shown(senderItems, "mara", "No permission to send")}
          status={status()}
          onRetry={reset}
          empty="No senders are set up for this space."
          renderPreview={(item) => <RichSelectFacts facts={senderFacts[item.value] ?? []} />}
        />
      </DemoCard>
      <DemoCard
        id="rich-select-sharing"
        chip={{ kind: "component", name: "RichSelect", from: "@k2b/ui" }}
        description="Sharing level: one short line explains each choice, so there is no preview. The last manager cannot reduce their own access."
        code={`<RichSelect
  label="Sharing level"
  title="Your access"
  value={access}
  onValueChange={setAccess}
  items={sharingItems}
/>`}
      >
        <RichSelect
          label="Sharing level"
          title="Your access"
          value={access}
          onValueChange={setAccess}
          items={shown(sharingItems, access(), "Only managers change access")}
          status={status()}
          onRetry={reset}
          empty="No sharing levels are available."
        />
      </DemoCard>
    </DemoGrid>
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
        <NumberInput label="Capacity" value={capacity} onValueChange={setCapacity} suffix="%" min={0} max={100} step={5} />
        <NumberInput label="Workers" value={count} onValueChange={setCount} min={1} max={64} step={1} />
      </div>
    </DemoCard>
  );
};

const DateDemo = () => {
  const [date, setDate] = createSignal<string | null>("2026-07-28");
  const [due, setDue] = createSignal<string | null>(null);
  const [dateTime, setDateTime] = createSignal<string | null>("2026-07-28T09:30");
  const [deadline, setDeadline] = createSignal<string | null>("2026-07-31");
  const [range, setRange] = createSignal<DateRangeValue>({
    start: "2026-07-28",
    end: "2026-07-31",
  });
  const [dateTimeRange, setDateTimeRange] = createSignal<DateRangeValue>({
    start: "2026-07-28T09:00",
    end: "2026-07-28T10:00",
  });
  const [singleDayRange, setSingleDayRange] = createSignal<DateRangeValue>({ start: "2026-07-28", end: "2026-07-28" });
  const [fridayWeekendDate, setFridayWeekendDate] = createSignal<string | null>("2026-07-31");
  return (
    <DemoCard
      id="date-picker"
      chip={[
        { kind: "component", name: "DatePicker", from: "@k2b/ui" },
        { kind: "component", name: "DateTimePicker", from: "@k2b/ui" },
        { kind: "component", name: "DateRangePicker", from: "@k2b/ui" },
      ]}
      description="Date, date-time, and range pickers share one controlled, timezone-aware calendar interaction with clear and preset support. Every calendar marks today in its time zone; the empty Due picker opens on it. The Deadline picker keeps a date and adds a time only on request."
      code={`<DatePicker label="Release date" value={date()} onValueChange={setDate} clearable />
<DatePicker label="Due" placeholder="Pick a due date" value={due()} onValueChange={setDue} dateConfig={dateConfig} clearable />
<DateTimePicker label="Starts at" value={dateTime()} onValueChange={setDateTime} dateConfig={dateConfig} />
<DateTimePicker label="Deadline" optionalTime defaultTime="17:00" value={deadline()} onValueChange={setDeadline} dateConfig={dateConfig} clearable />
<DateRangePicker label="Window" value={range()} onValueChange={setRange} presets={datePresets} />
<DateRangePicker label="One-day range" value={singleDayRange()} onValueChange={setSingleDayRange} />
<DatePicker label="Friday/Saturday weekend (he-IL)" value={fridayWeekendDate()} onValueChange={setFridayWeekendDate} dateConfig={{ locale: "he-IL" }} />
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
        <DatePicker
          label="Friday/Saturday weekend (he-IL)"
          value={fridayWeekendDate()}
          onValueChange={setFridayWeekendDate}
          dateConfig={{ locale: "he-IL" }}
        />
        <DateRangePicker label="One-day range" value={singleDayRange()} onValueChange={setSingleDayRange} />
        <DatePicker
          label="Due"
          placeholder="Pick a due date"
          value={due()}
          onValueChange={setDue}
          dateConfig={{ timeZone: "Europe/Berlin", weekStartsOn: 1 }}
          clearable
        />
        <DateTimePicker
          label="Starts at"
          value={dateTime()}
          onValueChange={setDateTime}
          dateConfig={{ timeZone: "Europe/Berlin", weekStartsOn: 1 }}
        />
        <DateTimePicker
          label="Deadline"
          optionalTime
          defaultTime="17:00"
          value={deadline()}
          onValueChange={setDeadline}
          dateConfig={{ timeZone: "Europe/Berlin", weekStartsOn: 1 }}
          clearable
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
  const [narrow, setNarrow] = createSignal(["platform", "design", "docs"]);
  const [chip, setChip] = createSignal("week");
  return (
    <DemoCard
      id="select"
      chip={[
        { kind: "component", name: "Select", from: "@k2b/ui" },
        { kind: "component", name: "MultiSelectInput", from: "@k2b/ui" },
        { kind: "component", name: "SelectChip", from: "@k2b/ui" },
      ]}
      description="Select filters its static options only when searchable is set; MultiSelectInput renders its search field by default. An option color replaces the icon with a dot in Select, and tints the icon and selected pill in MultiSelectInput. In a narrow trigger, pills that do not fit collapse into a +N summary. SelectChip is the compact form: a 10rem menu with a trailing check marker."
      code={`<Select label="Team" description="Type to filter the static options." value={team} options={options} onValueChange={setTeam} searchable clearable />

{/* MultiSelectInput always renders its search field */}
<MultiSelectInput label="Teams" value={teams} onValueChange={setTeams} options={options} clearable />

{/* Pills that do not fit collapse into a +N summary */}
<div style="width:10rem">
  <MultiSelectInput label="Teams (narrow)" value={teams} onValueChange={setTeams} options={options} clearable />
</div>

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
        <div style="width:10rem">
          <MultiSelectInput label="Teams (narrow)" value={narrow} onValueChange={setNarrow} options={options} clearable />
        </div>
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
  const [values, setValues] = createSignal(["coffee", "briefcase"]);
  return (
    <DemoCard
      id="select-groups"
      chip={{ kind: "component", name: "Select", from: "@k2b/ui" }}
      description="Select and MultiSelectInput can narrow one option list with the same optional group chips. Options may belong to several groups; text search stays inside the active group, and All removes the group filter."
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
/>;

<MultiSelectInput
  label="Icons"
  value={icons}
  onValueChange={setIcons}
  options={options}
  groups={groups}
  defaultGroup="recommended"
/>`}
    >
      <div class="ui-demo-stack">
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
        <MultiSelectInput
          label="Icons"
          value={values}
          onValueChange={setValues}
          options={groupedOptions}
          groups={selectGroups}
          defaultGroup="recommended"
          clearable
        />
      </div>
    </DemoCard>
  );
};

const SelectViewsDemo = () => {
  const [value, setValue] = createSignal("coffee");
  return (
    <DemoCard
      id="select-views"
      chip={{ kind: "component", name: "Select", from: "@k2b/ui" }}
      description="An optional, local layout switch keeps the same filtered options and selection semantics while moving between detailed rows and compact tiles. The tile size is a bounded density choice, not consumer-owned CSS."
      code={`<Select
  label="Icon"
  value={icon}
  onValueChange={setIcon}
  options={options}
  groups={groups}
  defaultGroup="recommended"
  viewToggle
  defaultView="grid"
  gridSize="md"
  searchable
/>`}
    >
      <Select
        label="Icon"
        description="Use the icon beside the groups to switch between detailed rows and compact tiles."
        value={value}
        onValueChange={setValue}
        options={groupedOptions}
        groups={selectGroups}
        defaultGroup="recommended"
        viewToggle
        defaultView="grid"
        gridSize="md"
        searchable
        clearable
      />
    </DemoCard>
  );
};

const AutocompleteSelectWorkflowDemo = () => {
  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [category, setCategory] = createSignal<string | null>("551");
  return (
    <DemoCard
      id="autocomplete-select-workflow"
      chip={{ kind: "component", name: "AutocompleteSelect", from: "@k2b/ui" }}
      description="A form can keep its native Tab order while a known code or an unambiguous label prefix completes the controlled category. Focus Title, then move through the fields without reaching an extra button."
      code={`const [category, setCategory] = createSignal<string | null>("551");

<AutocompleteSelect
  label="Category"
  value={category}
  onValueChange={setCategory}
  selectedOption={{ value: "551", label: "Gemälde" }}
  search={searchCategories}
  formatValue={(option) => \`\${option.value} — \${option.label}\`}
/>`}
    >
      <div class="ui-demo-stack">
        <TextInput label="Title" value={title} onValueChange={setTitle} placeholder="Start here, then press Tab" />
        <TextInput label="Description" value={description} onValueChange={setDescription} multiline lines={3} />
        <AutocompleteSelect
          label="Category"
          description="Try 551 or gem, then press Tab. Escape restores the value present when editing began."
          value={category}
          onValueChange={setCategory}
          selectedOption={artCategories[0]}
          search={searchArtCategories}
          groups={artCategoryGroups}
          defaultGroup="recommended"
          formatValue={(option) => `${option.value} — ${option.label}`}
          clearable
        />
      </div>
    </DemoCard>
  );
};

const AutocompleteSelectFuzzyDemo = () => {
  const [category, setCategory] = createSignal<string | null>(null);
  return (
    <DemoCard
      id="autocomplete-select-fuzzy"
      chip={[
        { kind: "component", name: "AutocompleteSelect", from: "@k2b/ui" },
        { kind: "component", name: "fuzzy", from: "@k2b/stdlib" },
      ]}
      description="The application owns matching and ranking. This provider uses @k2b/stdlib fuzzy search for forgiving suggestions, but returns match only for an exact code, exact label, or one unambiguous prefix."
      code={`import { fuzzy } from "@k2b/stdlib";

const search = async (query, signal, group) => {
  const source = group ? categories.filter((option) => option.groups?.includes(group)) : categories;
  const options = fuzzy.filter(query, source, {
    key: (option) => \`\${option.value} \${option.label} \${option.description}\`,
    limit: 6,
  }).map((hit) => hit.item);
  return { options, match: findSafeMatch(query) };
};

<AutocompleteSelect
  label="Art category"
  value={category}
  onValueChange={setCategory}
  search={search}
  groups={categoryGroups}
  debounceMs={0}
/>`}
    >
      <AutocompleteSelect
        label="Art category"
        description="Try druck, skulptur, or an abbreviated label. Arrow keys and Enter select a fuzzy suggestion explicitly."
        value={category}
        onValueChange={setCategory}
        selectedOption={artCategories.find((option) => option.value === category())}
        search={searchArtCategoriesImmediately}
        groups={artCategoryGroups}
        debounceMs={0}
        placeholder="Search code, label, or path…"
        clearable
      />
    </DemoCard>
  );
};

const AutocompleteSelectFeedbackDemo = () => {
  const [category, setCategory] = createSignal<string | null>("551");
  const search = async (query: string, signal: AbortSignal): Promise<AutocompleteSelectSearchResult> => {
    if (normalizeCategoryQuery(query) === "offline") {
      await waitForCategorySearch(signal);
      throw new Error("Category service unavailable");
    }
    return searchArtCategories(query, signal);
  };
  return (
    <DemoCard
      id="autocomplete-select-feedback"
      chip={{ kind: "component", name: "AutocompleteSelect", from: "@k2b/ui" }}
      description="No match and a failed search are separate states. Tab is never trapped: validation appears after focus moves, and a late authoritative async result may still commit."
      code={`<AutocompleteSelect
  label="Category"
  value={category}
  onValueChange={setCategory}
  search={search}
  noMatchText="No matching category found"
/>`}
    >
      <AutocompleteSelect
        label="Category with validation"
        description="Type 552 and press Tab for no match. Type offline for a technical error. Escape restores 551 — Gemälde."
        value={category}
        onValueChange={setCategory}
        selectedOption={artCategories[0]}
        search={search}
        formatValue={(option) => `${option.value} — ${option.label}`}
        noMatchText="No matching category found"
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
          <Tag color="#8b5cf6" icon="ti ti-palette">
            Design
          </Tag>
          <Tag size="sm">Neutral</Tag>
          <Tag color="#2563eb" icon="ti ti-point" selected size="lg">
            Selected
          </Tag>
        </div>
        <TagEditor
          items={items()}
          onCreate={async (value) => {
            setItems((current) => [...current, { id: `tag-${nextId++}`, ...value }]);
          }}
          onUpdate={async (tag, value) => {
            setItems((current) => current.map((item) => (item.id === tag.id ? { ...item, ...value } : item)));
          }}
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
          renderOption={(option) => (
            <span class="ui-demo-choice-copy">
              <strong>{option.label}</strong>
              <small>Reusable project tag</small>
            </span>
          )}
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

const FileDropTargetDemo = () => {
  const [area, setArea] = createSignal<HTMLDivElement>();
  const [last, setLast] = createSignal("Drag files from your computer over this window.");
  const received = (folder: string) => (files: File[]) => {
    setLast(`${folder}: ${files.map((file) => file.name).join(", ")}`);
  };
  return (
    <DemoCard
      id="file-drop-target"
      chip={{ kind: "component", name: "FileDropTarget", from: "@k2b/ui" }}
      description="While files are dragged over the window, the whole area shows where they land; the folder row is the more specific target and wins under the pointer. Uploading stays with the application."
      code={`<FileDropTarget
  for={area()}
  label="Drop to upload to “Projects”"
  onDrop={(files) => upload(files, "Projects")}
/>
<div ref={fileDropTarget({
  label: "Drop to upload to “Invoices”",
  onDrop: (files) => upload(files, "Projects/Invoices"),
})}>Invoices</div>`}
    >
      <div ref={setArea} style={{ display: "grid", gap: "0.5rem", padding: "1rem", "min-height": "12rem", "align-content": "start" }}>
        <FileDropTarget for={area()} label="Drop to upload to “Projects”" onDrop={received("Projects")} />
        <div
          ref={fileDropTarget({ label: "Drop to upload to “Invoices”", onDrop: received("Invoices") })}
          style={{
            display: "flex",
            gap: "0.5rem",
            "align-items": "center",
            padding: "0.5rem 0.75rem",
            "border-radius": "var(--k2b-radius-control)",
          }}
        >
          <i class="ti ti-folder" aria-hidden="true" />
          Invoices
        </div>
        <p style={{ margin: 0, color: "var(--k2b-text-muted)", "font-size": "0.875rem" }}>{last()}</p>
      </div>
    </DemoCard>
  );
};

const CropDemo = () => {
  const [, setCrop] = createSignal<ImageCropState | null>(null);
  const [aspect, setAspect] = createSignal<CropAspectPreset>("square");
  const cropAspect = () => (aspect() === "square" ? { width: 1, height: 1 } : aspect() === "wide" ? { width: 16, height: 9 } : "free");
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
        <ImageCropper source={cropDemoSource} aspect={cropAspect()} previewShape="rect" onValueChange={setCrop} />
      </div>
    </DemoCard>
  );
};

const SignatureDemo = () => {
  const [signature, setSignature] = createSignal<SignatureValue | null>(null);
  const [png, setPng] = createSignal("");
  const summary = () => {
    const value = signature();
    if (!value) return "No signature yet.";
    const size = `${(new Blob([value.svg]).size / 1024).toFixed(1)} kB SVG`;
    return value.kind === "typed" ? `Typed “${value.name}”, ${size}.` : `Drawn, ${size}.`;
  };
  return (
    <DemoCard
      id="signature"
      chip={{ kind: "component", name: "SignatureInput", from: "@k2b/ui" }}
      description="Draw with a finger, pen, or mouse, or type the name. The value is an SVG plus how it was given; the application stores it and records who signed and when."
      code={`const [signature, setSignature] = createSignal<SignatureValue | null>(null);

<SignatureInput
  label="Signature"
  description="Confirms that the items were received."
  required
  value={signature}
  onValueChange={setSignature}
/>

const current = signature();
const png = current ? await signatureToPng(current, { background: "#ffffff" }) : null;`}
    >
      <div class="ui-demo-form-grid">
        <SignatureInput
          label="Signature"
          description="Confirms that the items were received."
          required
          value={signature}
          onValueChange={(value) => {
            setSignature(value);
            setPng("");
          }}
        />
        <div class="ui-demo-row">
          <Button
            variant="secondary"
            size="sm"
            disabled={!signature()}
            onClick={async () => {
              const current = signature();
              if (!current) return;
              const url = await signatureToPng(current, { background: "#ffffff" });
              setPng(`PNG ready, ${(url.length / 1024).toFixed(1)} kB as a data URL.`);
            }}
          >
            Export PNG
          </Button>
          <span>{png() || summary()}</span>
        </div>
        <SignatureInput label="Read-only copy" readOnly value={signature} />
      </div>
    </DemoCard>
  );
};

const BooleanDemo = () => {
  const [enabled, setEnabled] = createSignal(true);
  const [checked, setChecked] = createSignal(false);
  const [done, setDone] = createSignal(false);
  return (
    <DemoCard
      id="boolean"
      chip={[
        { kind: "component", name: "Switch", from: "@k2b/ui" },
        { kind: "component", name: "Checkbox", from: "@k2b/ui" },
        { kind: "component", name: "CheckboxCard", from: "@k2b/ui" },
      ]}
      description="Native checkbox semantics wrapped in three accessor-controlled presentations for immediate settings, form choices, and descriptive cards. Point at or focus an open checkbox to preview the tick; ticking pops the check in."
      code={`<Switch label="Automation" value={enabled} onValueChange={setEnabled} />
<Checkbox label="Send a summary" description="Notify everyone when the run finishes." value={checked} onValueChange={setChecked} />
<Checkbox aria-label="Mark complete: Book the room" value={done} onValueChange={setDone} />
<CheckboxCard label="Early access" description="Preview new components." icon="ti ti-flask" value={checked} onValueChange={setChecked} />`}
    >
      <div class="ui-demo-form-grid">
        <Switch label="Automation" value={enabled} onValueChange={setEnabled} />
        <Checkbox label="Send a summary" description="Notify everyone when the run finishes." value={checked} onValueChange={setChecked} />
        <div class="flex items-center gap-3 text-sm">
          <Checkbox aria-label="Mark complete: Book the room" value={done} onValueChange={setDone} />
          <span class={done() ? "text-dimmed line-through" : undefined}>Book the room</span>
        </div>
        <CheckboxCard
          label="Early access"
          description="Preview new components."
          icon="ti ti-flask"
          value={checked}
          onValueChange={setChecked}
        />
      </div>
    </DemoCard>
  );
};

const ChoiceChipsDemo = () => {
  const [due, setDue] = createSignal<string | null>("2026-10-14");
  const [template, setTemplate] = createSignal<string | null>("blank");
  return (
    <DemoCard
      id="choice-chips"
      chip={{ kind: "component", name: "ChoiceChips", from: "@k2b/ui" }}
      description="A labeled radio group of quick choices. The row scrolls sideways instead of wrapping, so its height never changes; null selects no chip, and touch screens get 44 px targets."
      code={`<ChoiceChips
  label="Due"
  description="Proposed from the template · Wed or Thu · 17:00"
  value={due}
  onValueChange={setDue}
  options={[
    { value: "2026-10-14", label: "Wed 10/14" },
    { value: "2026-10-15", label: "Thu 10/15" },
    { value: "2026-10-21", label: "Wed 10/21" },
    { value: "other", label: "Other date…", icon: "ti ti-calendar" },
  ]}
/>`}
    >
      <div class="flex flex-col gap-4">
        <ChoiceChips
          label="Template"
          value={template}
          onValueChange={setTemplate}
          options={[
            { value: "blank", label: "Blank" },
            { value: "weekly", label: "Weekly report", icon: "ti ti-template" },
            { value: "release", label: "Release check", icon: "ti ti-template" },
            { value: "invoices", label: "Check invoices", icon: "ti ti-template" },
          ]}
        />
        <ChoiceChips
          label="Due"
          description="Proposed from the template · Wed or Thu · 17:00"
          value={due}
          onValueChange={setDue}
          options={[
            { value: "2026-10-14", label: "Wed 10/14" },
            { value: "2026-10-15", label: "Thu 10/15" },
            { value: "2026-10-21", label: "Wed 10/21" },
            { value: "other", label: "Other date…", icon: "ti ti-calendar" },
            { value: "none", label: "No date" },
          ]}
        />
      </div>
    </DemoCard>
  );
};

const shapePreview = (radius: string, fill: string) => (
  <span style={{ display: "inline-block", width: "3rem", height: "3rem", "border-radius": radius, background: fill }} />
);

const ChoiceTilesDemo = () => {
  const [shape, setShape] = createSignal<string | null>("round");
  const [kind, setKind] = createSignal<string | null>("drawing");
  return (
    <DemoCard
      id="choice-tiles"
      chip={{ kind: "component", name: "ChoiceTiles", from: "@k2b/ui" }}
      description="A labeled radio group of tiles with a preview. Choosing changes only fill and colour, so no tile moves; the row layout keeps a status line under every label and stacks on phones."
      code={`<ChoiceTiles
  label="Frame"
  value={shape}
  onValueChange={setShape}
  options={[
    { value: "round", label: "Round", visual: <RoundPreview /> },
    { value: "square", label: "Square", visual: <SquarePreview /> },
  ]}
/>`}
    >
      <div class="flex flex-col gap-4">
        <ChoiceTiles
          aria-label="Kind of picture"
          layout="row"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "photo", label: "Photo", visual: shapePreview("9999px", "#a7c7e7") },
            { value: "drawing", label: "Drawing", visual: shapePreview("9999px", "#f5e6c6"), status: "Active" },
            { value: "letters", label: "Letters", visual: shapePreview("9999px", "#dbe7fe") },
          ]}
        />
        <ChoiceTiles
          label="Frame"
          value={shape}
          onValueChange={setShape}
          options={[
            { value: "round", label: "Round", visual: shapePreview("9999px", "#d3efe1") },
            { value: "soft", label: "Soft", visual: shapePreview("28%", "#d3efe1") },
            { value: "square", label: "Square", visual: shapePreview("0.25rem", "#d3efe1") },
          ]}
        />
      </div>
    </DemoCard>
  );
};

const ColorChoicesDemo = () => {
  const [color, setColor] = createSignal<string | null>("teal");
  return (
    <DemoCard
      id="color-choices"
      chip={{ kind: "component", name: "ColorChoices", from: "@k2b/ui" }}
      description="A labeled radio group of named colour swatches. Every swatch carries its name, so colour is never the only signal; touch screens get 44 px swatches."
      code={`<ColorChoices
  label="Background"
  value={color}
  onValueChange={setColor}
  options={[
    { value: "sky", label: "Sky", color: "#d7e8fb" },
    { value: "teal", label: "Teal", color: "#15837f" },
  ]}
/>`}
    >
      <ColorChoices
        label="Background"
        value={color}
        onValueChange={setColor}
        options={[
          { value: "sky", label: "Sky", color: "#d7e8fb" },
          { value: "mint", label: "Mint", color: "#d3efe1" },
          { value: "sand", label: "Sand", color: "#f5e6c6" },
          { value: "rose", label: "Rose", color: "#f7dbe1" },
          { value: "teal", label: "Teal", color: "#15837f" },
          { value: "stone", label: "Stone", color: "#57534e" },
        ]}
      />
    </DemoCard>
  );
};

const EmojiPickerDemo = () => {
  const [recent, setRecent] = createSignal<readonly string[]>(["👍", "🎉", "☕"]);
  const [tone, setTone] = createSignal<EmojiSkinTone>(0);
  const [picked, setPicked] = createSignal("");
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const pick = (emoji: string) => {
    setPicked(emoji);
    setRecent(rememberEmoji(recent(), emoji));
  };
  return (
    <DemoCard
      id="emoji-picker"
      chip={{ kind: "component", name: "EmojiPicker", from: "@k2b/ui" }}
      description="Search in English and German, recently used emoji, skin tones, and the whole grid with the keyboard: arrows move, Enter picks. The data loads when the picker first opens. EmojiPicker.Popover opens it next to a button."
      code={`const [recent, setRecent] = createSignal<readonly string[]>(stored.recentEmoji);
const [tone, setTone] = createSignal<EmojiSkinTone>(stored.skinTone);
const [anchor, setAnchor] = createSignal<HTMLElement>();

<Button onClick={(event) => setAnchor(event.currentTarget)}>Add reaction</Button>
<EmojiPicker.Popover
  anchor={anchor()}
  recent={recent()}
  skinTone={tone()}
  onSkinToneChange={setTone}
  onPick={(emoji) => {
    react(emoji);
    setRecent(rememberEmoji(recent(), emoji));
  }}
  onClose={() => setAnchor(undefined)}
/>`}
    >
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "1.5rem", "align-items": "flex-start" }}>
        <EmojiPicker recent={recent()} skinTone={tone()} onSkinToneChange={setTone} onPick={pick} />
        <div style={{ display: "grid", gap: "0.75rem", "justify-items": "start" }}>
          <Button variant="subtle" onClick={(event) => setAnchor(event.currentTarget)}>
            <i class="ti ti-mood-plus" aria-hidden="true" />
            Add reaction
          </Button>
          <EmojiPicker.Popover
            anchor={anchor()}
            recent={recent()}
            skinTone={tone()}
            onSkinToneChange={setTone}
            onPick={pick}
            onClose={() => setAnchor(undefined)}
          />
          <span>Picked: {picked() || "nothing yet"}</span>
        </div>
      </div>
    </DemoCard>
  );
};

const demos: DemoSection = {
  "emoji-picker": () => (
    <DemoGrid columns="one">
      <EmojiPickerDemo />
    </DemoGrid>
  ),
  "qr-scanner": () => <QrScannerDemo />,
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
  "rich-select": () => <RichSelectDemo />,
  select: () => (
    <DemoGrid columns="one">
      <SelectDemo />
      <GroupedSelectDemo />
      <SelectViewsDemo />
    </DemoGrid>
  ),
  "choice-chips": () => (
    <DemoGrid columns="one">
      <ChoiceChipsDemo />
    </DemoGrid>
  ),
  "choice-tiles": () => (
    <DemoGrid columns="one">
      <ChoiceTilesDemo />
    </DemoGrid>
  ),
  "color-choices": () => (
    <DemoGrid columns="one">
      <ColorChoicesDemo />
    </DemoGrid>
  ),
  "autocomplete-select": () => (
    <DemoGrid columns="one">
      <AutocompleteSelectWorkflowDemo />
      <AutocompleteSelectFuzzyDemo />
      <AutocompleteSelectFeedbackDemo />
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
  signature: () => (
    <DemoGrid columns="one">
      <SignatureDemo />
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
  "file-drop-target": () => (
    <DemoGrid columns="one">
      <FileDropTargetDemo />
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
