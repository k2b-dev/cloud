import { text } from "@k2b/stdlib";
import { checkMimeType } from "@k2b/stdlib/browser";
import { type Accessor, createSignal } from "solid-js";
import { announce } from "../feedback/announce";
import { toast } from "../feedback/toast";
import type { UiMessages } from "../intl/messages";

export type FileDropRejection = {
  file: File;
  /** `type` misses `accept`, `size` exceeds `maxSize`, `count` is past `maxFiles` or the single file of `multiple={false}`. */
  reason: "type" | "size" | "count";
};

export type FileDropDetails = {
  /** The drop's data, readable only while `onDrop` runs synchronously; read folder entries before the first `await`. */
  dataTransfer: DataTransfer;
  /** Files left out by `accept`, `maxSize`, or the file count; the user has already been told. */
  rejected: readonly FileDropRejection[];
};

export type FileDropOptions = {
  /** One sentence that says what dropping does here, such as "Drop to attach to the message". */
  label: string;
  /** `<input accept>` syntax, such as `"image/*,.pdf"`. */
  accept?: string;
  /** Defaults to `true`; `false` takes the first fitting file. */
  multiple?: boolean;
  /** The most files one drop hands over. */
  maxFiles?: number;
  /** The largest file in bytes. */
  maxSize?: number;
  disabled?: boolean;
  /**
   * Called synchronously in the drop with the files that fit. `files` is empty only when the drop carried no file
   * objects at all, as some engines hand over dropped folders; `details.dataTransfer.items` still has their entries.
   */
  onDrop: (files: File[], details: FileDropDetails) => void | Promise<void>;
};

export type FileDropTargetEntry = {
  options: FileDropOptions;
  messages: () => UiMessages;
  locale: () => string;
  /** Set for regions: the area the overlay covers. Specific targets are keyed by their element. */
  region?: () => Element | undefined;
};

export type FileDropHover = { entry: FileDropTargetEntry; element: Element; invalid: boolean };

export type FileDropSession = {
  /** Regions that show their overlay during this drag: eligible, visible, and not inside another shown region. */
  shown: readonly FileDropTargetEntry[];
  hover: FileDropHover | null;
};

export type FileDropEngine = {
  session: Accessor<FileDropSession | null>;
  /** Changes on every drag movement, so overlays can follow a region that moved or resized. */
  frame: Accessor<number>;
  addRegion: (entry: FileDropTargetEntry) => () => void;
  setTarget: (element: Element, entry: FileDropTargetEntry) => void;
};

/** The marker a hovered specific target carries for its ring; regions show their own overlay instead. */
export const FILE_DROP_ATTRIBUTE = "data-file-drop";

/** Where a region without `for` looks for its area: the nearest dialog, workspace detail, or workspace main area. */
export const FILE_DROP_DEFAULT_REGION = "dialog, .k2b-app-workspace__detail, .k2b-app-workspace__main";

const engines = new WeakMap<Document, FileDropEngine>();

const isFileDrag = (event: DragEvent) => {
  const types = event.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
};

const elementOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target : target instanceof Node ? target.parentElement : null;

const topModal = (doc: Document): Element | null => {
  let top: Element | null = null;
  for (const dialog of Array.from(doc.querySelectorAll("dialog[open]"))) {
    try {
      if (dialog.matches(":modal")) top = dialog;
    } catch {
      // An engine without `:modal` has no modal dialogs to defer to.
    }
  }
  return top;
};

/** Sorts dropped files into the ones a target takes and the ones it leaves out, in drop order. */
export const partitionDroppedFiles = (
  files: readonly File[],
  options: Pick<FileDropOptions, "accept" | "multiple" | "maxFiles" | "maxSize">,
): { accepted: File[]; rejected: FileDropRejection[] } => {
  const limit = options.multiple === false ? 1 : (options.maxFiles ?? Number.POSITIVE_INFINITY);
  const accepted: File[] = [];
  const rejected: FileDropRejection[] = [];
  for (const file of files) {
    if (options.accept && !checkMimeType(file, options.accept)) rejected.push({ file, reason: "type" });
    else if (options.maxSize !== undefined && file.size > options.maxSize) rejected.push({ file, reason: "size" });
    else if (accepted.length >= limit) rejected.push({ file, reason: "count" });
    else accepted.push(file);
  }
  return { accepted, rejected };
};

/** During a drag only the types are readable, and only in some engines; a drag is invalid when none of them can fit. */
const invalidDrag = (event: DragEvent, options: FileDropOptions) => {
  if (!options.accept) return false;
  const items = Array.from(event.dataTransfer?.items ?? []).filter((item) => item.kind === "file");
  return items.length > 0 && items.every((item) => item.type !== "" && !checkMimeType(item.type, options.accept!));
};

const MAX_NAMES = 3;
const nameList = (files: readonly File[], messages: UiMessages) => {
  const names = files.slice(0, MAX_NAMES).map((file) => file.name);
  return files.length > MAX_NAMES ? `${names.join(", ")} ${messages.fileDropMore({ count: files.length - MAX_NAMES })}` : names.join(", ");
};

export const fileDropRejectionMessage = (
  rejected: readonly FileDropRejection[],
  options: Pick<FileDropOptions, "multiple" | "maxFiles" | "maxSize">,
  messages: UiMessages,
  locale: string,
): string => {
  const lines: string[] = [];
  const of = (reason: FileDropRejection["reason"]) => rejected.filter((entry) => entry.reason === reason).map((entry) => entry.file);
  const type = of("type");
  const size = of("size");
  const count = of("count");
  if (type.length) lines.push(messages.fileDropRejectedType({ names: nameList(type, messages) }));
  if (size.length)
    lines.push(
      messages.fileDropRejectedSize({ names: nameList(size, messages), limit: text.pprintBytes(options.maxSize ?? 0, { locale }) }),
    );
  if (count.length)
    lines.push(
      messages.fileDropRejectedCount({ names: nameList(count, messages), max: options.multiple === false ? 1 : (options.maxFiles ?? 1) }),
    );
  return lines.join("\n");
};

const createEngine = (doc: Document): FileDropEngine => {
  const view = doc.defaultView;
  const regions = new Set<FileDropTargetEntry>();
  const targets = new WeakMap<Element, FileDropTargetEntry>();
  const [session, setSession] = createSignal<FileDropSession | null>(null);
  const [frame, setFrame] = createSignal(0);
  /** Elements the drag has entered and not yet left; the drag is over the window while any remains. */
  const entered = new Set<EventTarget>();
  /** A drag that started in this document carries page content, never files from outside. */
  let internal = false;
  let marked: Element | null = null;
  let frameRequest = 0;

  const mark = (hover: FileDropHover | null) => {
    if (marked && marked !== hover?.element) marked.removeAttribute(FILE_DROP_ATTRIBUTE);
    marked = null;
    if (!hover || hover.entry.region) return;
    marked = hover.element;
    marked.setAttribute(FILE_DROP_ATTRIBUTE, hover.invalid ? "invalid" : "over");
  };

  const regionElement = (entry: FileDropTargetEntry) => {
    const element = entry.region?.();
    return element?.isConnected ? element : undefined;
  };

  /** A region takes part when it is enabled and not behind a modal dialog it is not inside of. */
  const eligible = (entry: FileDropTargetEntry, modal: Element | null) => {
    const element = regionElement(entry);
    if (!element || entry.options.disabled) return false;
    return !modal || modal.contains(element);
  };
  const rendered = (element: Element) => element === doc.documentElement || element.getClientRects().length > 0;

  const begin = () => {
    const modal = topModal(doc);
    const candidates = [...regions].filter((entry) => eligible(entry, modal) && rendered(regionElement(entry)!));
    // The latest region on an element replaces earlier ones; a region inside another shown one acts as a specific target.
    const byElement = new Map<Element, FileDropTargetEntry>();
    for (const entry of candidates) byElement.set(regionElement(entry)!, entry);
    const shown = [...byElement].filter(
      ([element]) => ![...byElement.keys()].some((other) => other !== element && other.contains(element)),
    );
    setSession({ shown: shown.map(([, entry]) => entry), hover: null });
    const first = shown[0]?.[1];
    if (first) announce(first.options.label);
  };

  const end = () => {
    entered.clear();
    mark(null);
    if (session()) setSession(null);
  };

  const resolve = (target: EventTarget | null): { entry: FileDropTargetEntry; element: Element } | null => {
    const modal = topModal(doc);
    for (let element = elementOf(target); element; element = element.parentElement) {
      const specific = targets.get(element);
      if (specific && !specific.options.disabled) return { entry: specific, element };
      let region: FileDropTargetEntry | undefined;
      for (const entry of regions) if (regionElement(entry) === element && eligible(entry, modal)) region = entry;
      if (region) return { entry: region, element };
    }
    return null;
  };

  const hoverFrom = (event: DragEvent) => {
    const current = session();
    if (!current) return null;
    const found = resolve(event.target);
    const hover = found ? { ...found, invalid: invalidDrag(event, found.entry.options) } : null;
    const previous = current.hover;
    if (previous?.entry !== hover?.entry || previous?.element !== hover?.element || previous?.invalid !== hover?.invalid) {
      mark(hover);
      setSession({ ...current, hover });
    }
    return hover;
  };

  /** Over a page with a region, a file never falls through to the browser, which would open it and leave the page. */
  const guarding = () => [...regions].some((entry) => regionElement(entry));

  const accept = (event: DragEvent, hover: FileDropHover | null) => {
    if (!hover && !guarding()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = hover && !hover.invalid ? "copy" : "none";
  };

  const requestFrame = () => {
    if (frameRequest || !view) return;
    frameRequest = view.requestAnimationFrame(() => {
      frameRequest = 0;
      setFrame((value) => value + 1);
    });
  };

  const deliver = (entry: FileDropTargetEntry, dataTransfer: DataTransfer) => {
    const { options } = entry;
    const files = Array.from(dataTransfer.files);
    const { accepted, rejected } = partitionDroppedFiles(files, options);
    const messages = entry.messages();
    if (rejected.length) toast.error(fileDropRejectionMessage(rejected, options, messages, entry.locale()));
    if (!accepted.length && files.length) return;
    if (accepted.length)
      announce(
        accepted.length === 1
          ? messages.fileDropDroppedOne({ name: accepted[0]!.name })
          : messages.fileDropDropped({ count: accepted.length }),
      );
    void options.onDrop(accepted, { dataTransfer, rejected });
  };

  const listeners: Record<string, (event: Event) => void> = {
    dragstart: () => {
      internal = true;
    },
    dragend: () => {
      internal = false;
      end();
    },
    dragenter: (event) => {
      const drag = event as DragEvent;
      if (internal || !isFileDrag(drag)) return;
      if (event.target) entered.add(event.target);
      if (!session()) begin();
      accept(drag, hoverFrom(drag));
    },
    dragover: (event) => {
      const drag = event as DragEvent;
      if (internal || !isFileDrag(drag)) return;
      // An engine may skip the first dragenter; the drag still counts as over the window.
      if (!session()) {
        if (event.target) entered.add(event.target);
        begin();
      }
      accept(drag, hoverFrom(drag));
      requestFrame();
    },
    dragleave: (event) => {
      if (!session()) return;
      if (event.target) entered.delete(event.target);
      // An element removed during the drag never reports leaving.
      for (const target of entered) if (target instanceof Node && !target.isConnected) entered.delete(target);
      if (entered.size === 0) end();
    },
    drop: (event) => {
      const drag = event as DragEvent;
      if (internal || !isFileDrag(drag)) return;
      const found = resolve(event.target);
      end();
      if (!found) {
        if (guarding()) event.preventDefault();
        return;
      }
      // The most specific target owns the drop; editors and other handlers below it never see the files.
      event.preventDefault();
      event.stopPropagation();
      if (drag.dataTransfer) deliver(found.entry, drag.dataTransfer);
    },
    keydown: (event) => {
      if ((event as KeyboardEvent).key === "Escape" && session()) end();
    },
    // No pointer moves during a drag: one that arrives means the drag ended somewhere the page did not see.
    pointermove: () => {
      if (session()) end();
    },
    visibilitychange: () => {
      if (doc.visibilityState === "hidden") end();
    },
  };

  let installed = false;
  const install = () => {
    if (installed || !view) return;
    installed = true;
    for (const [type, listener] of Object.entries(listeners))
      (type === "visibilitychange" ? doc : view).addEventListener(type, listener, { capture: true });
  };

  return {
    session,
    frame,
    addRegion: (entry) => {
      install();
      regions.add(entry);
      return () => {
        regions.delete(entry);
        const current = session();
        if (current?.hover?.entry === entry) {
          mark(null);
          setSession({ ...current, hover: null });
        }
      };
    },
    setTarget: (element, entry) => {
      install();
      targets.set(element, entry);
    },
  };
};

/**
 * The document an element lives in. A freshly rendered element still belongs to the inert document of the template it
 * was cloned from; until it is inserted, that is the page's document.
 */
export const liveDocument = (element: Element): Document => (element.ownerDocument.defaultView ? element.ownerDocument : document);

/** The one drag tracker of a document, shared by every drop target in it. */
export const fileDropEngine = (doc: Document): FileDropEngine => {
  let engine = engines.get(doc);
  if (!engine) {
    engine = createEngine(doc);
    engines.set(doc, engine);
  }
  return engine;
};
