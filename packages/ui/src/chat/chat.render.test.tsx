import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const publicUi = await import("../index");
const { Chat, formatChatTokens } = publicUi;

describe("@k2b/ui portable chat family", () => {
  test("exposes one compound chat API without legacy runtime exports", () => {
    expect(Object.keys(Chat)).toEqual(["Timeline", "Message", "Activity", "Composer", "ContextUsage"]);
    for (const legacyExport of ["ChatTimeline", "ChatMessage", "ChatActivity", "ChatComposer", "ChatContextUsage"]) {
      expect(legacyExport in publicUi).toBe(false);
    }
  });

  test("renders controlled composition, commands, attachments, models, and runtime actions", () => {
    const html = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "/",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        onStop: () => undefined,
        state: "running",
        attachments: [
          {
            id: "brief",
            name: "brief.pdf",
            size: 12_000,
            kind: "file",
            href: "/files/brief",
            action: { id: "show", label: "Show in text field", icon: "ti ti-text-plus", onSelect: () => undefined },
          },
        ],
        onAttachmentsChange: () => undefined,
        fileSelection: { onSelect: () => undefined },
        models: [
          {
            id: "fast",
            label: "Fast model",
            description: "Low latency",
            image: "https://example.test/provider.svg",
          },
        ],
        selectedModelId: "fast",
        onModelChange: () => undefined,
        commands: [
          {
            name: "clear",
            description: "Clear the conversation",
            action: () => undefined,
          },
        ],
        contextUsage: {
          usage: { input: 1_000, output: 200 },
          contextWindow: 8_000,
        },
      }),
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain("/clear");
    expect(html).toContain("brief.pdf");
    expect(html).toContain('href="/files/brief"');
    expect(html).not.toContain("12 KB");
    expect(html).toContain("Fast model");
    expect(html).toContain('src="https://example.test/provider.svg"');
    expect(html).toContain('aria-label="Steer response"');
    expect(html).toContain("15%");
    expect(html).toContain('aria-label="Add to chat"');
    expect(html).toContain('aria-label="Remove brief.pdf"');
    expect(html).toContain('aria-label="Attachments" tabindex="0"');
    expect(html).toContain("Show in text field");
    expect(html).toContain("ti ti-text-plus");
    expect(html).toContain('role="option"');
    expect(html).toContain('role="menuitemradio"');
    expect(html).toContain("k2b-dropdown__copy");
  });

  test("exposes the open command list as a combobox popup owned by the textarea", () => {
    const commands = [
      {
        name: "clear",
        description: "Clear the conversation",
        action: () => undefined,
      },
    ];
    const withCommands = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "/cl",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        commands,
      }),
    );
    const withoutCommands = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "hello",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        commands,
      }),
    );

    expect(withCommands).toContain('role="combobox"');
    expect(withCommands).toContain('aria-autocomplete="list"');
    expect(withCommands).toContain('aria-expanded="true"');
    expect(withCommands).toMatch(/aria-controls="k2b-chat-commands-[^"]+"/);
    expect(withCommands).toMatch(/aria-activedescendant="k2b-chat-commands-[^"]+-0"/);
    expect(withCommands).toContain('tabindex="-1"');

    expect(withoutCommands).not.toContain('role="listbox"');
    expect(withoutCommands).not.toContain('role="combobox"');
    expect(withoutCommands).not.toContain("aria-expanded");
    expect(withoutCommands).not.toContain("aria-activedescendant");
  });

  test("labels the composer and disables submission without a draft or attachments", () => {
    const html = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        label: "Support composer",
        inputLabel: "Support message",
        error: "Model unavailable",
      }),
    );

    expect(html).toContain('aria-label="Support composer"');
    expect(html).toContain('aria-label="Support message"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Model unavailable");
    expect(html).toMatch(/class="k2b-chat-composer__send"[^>]*disabled/);
  });

  test("shows only stop while a response is running without a new draft", () => {
    const html = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        onStop: () => undefined,
        state: "running",
      }),
    );

    expect(html).toContain('aria-label="Stop response"');
    expect(html).toContain('class="ti ti-player-stop"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Steer response"');
  });

  test("lets applications queue drafts during a running response without changing the compatibility default", () => {
    const queued = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "Next question",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        onStop: () => undefined,
        state: "running",
        runningSubmitIntent: "queue",
      }),
    );
    const steered = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "Change direction",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        state: "running",
      }),
    );

    expect(queued).toContain('aria-label="Queue message"');
    expect(queued).not.toContain('aria-label="Steer response"');
    expect(steered).toContain('aria-label="Steer response"');
  });

  test("renders semantic messages and expandable activity", () => {
    const message = renderToString(() =>
      createComponent(Chat.Message, {
        role: "assistant",
        status: "streaming",
        createdAt: "2026-07-28T12:00:00.000Z",
        children: "Working on it",
        actions: [{ id: "retry", label: "Retry", icon: "ti ti-refresh", onSelect: () => undefined }],
      }),
    );
    const activity = renderToString(() =>
      createComponent(Chat.Activity, {
        label: "Looked up documentation",
        description: "2 sources",
        leading: "Source icon",
        accent: "#0f766e",
        defaultOpen: true,
        bodyInset: false,
        children: "Source details",
      }),
    );
    const controlledClosed = renderToString(() =>
      createComponent(Chat.Activity, {
        label: "Controlled disclosure",
        defaultOpen: true,
        open: false,
        children: "Controlled details",
      }),
    );

    expect(message).toContain('data-role="assistant"');
    expect(message).toContain('aria-busy="true"');
    expect(message).toContain('aria-label="Generating"');
    expect(message).toContain("k2b-chat-progress-dots");
    expect(message.match(/k2b-chat-progress-dots[^]*?<span><\/span><span><\/span><span><\/span>/)).not.toBeNull();
    expect(message).not.toContain(">Generating<");
    expect(message).not.toContain("ti ti-loader-2");
    expect(message).toContain("Retry");
    expect(activity).toContain("<details");
    expect(activity).toContain("open");
    expect(activity).toContain("Source details");
    expect(activity).toContain("Source icon");
    expect(activity).toContain('data-accent="true"');
    expect(activity).toContain('data-body-inset="false"');
    expect(activity).toContain("--k2b-chat-activity-accent:#0f766e");
    expect(controlledClosed).toContain("<details");
    expect(controlledClosed).not.toMatch(/<details\b[^>]*\sopen(?:=""|(?=[\s>]))/);
  });

  test("keeps visible timestamps explicit and SSR-stable", () => {
    const machineOnly = renderToString(() =>
      createComponent(Chat.Message, {
        role: "assistant",
        createdAt: "2026-07-28T12:00:00.000Z",
        children: "Machine timestamp only",
      }),
    );
    const visible = renderToString(() =>
      createComponent(Chat.Message, {
        role: "assistant",
        createdAt: "2026-07-28T12:00:00.000Z",
        timeLabel: "14:00",
        children: "Visible timestamp",
      }),
    );
    const emptyLabel = renderToString(() =>
      createComponent(Chat.Message, {
        role: "assistant",
        timeLabel: "",
        children: "No timestamp",
      }),
    );

    expect(machineOnly).not.toContain("<time");
    expect(machineOnly).not.toContain("k2b-chat-message__meta");
    expect(visible).toContain('<time datetime="2026-07-28T12:00:00.000Z">14:00</time>');
    expect(visible).toContain("k2b-chat-message__meta");
    expect(emptyLabel).not.toContain("k2b-chat-message__meta");
  });

  test("does not render an empty bubble for attachment-only messages", () => {
    const html = renderToString(() =>
      createComponent(Chat.Message, {
        role: "user",
        attachments: [{ id: "image", name: "image.png", kind: "image" }],
      }),
    );

    expect(html).toContain("k2b-chat-message__attachments");
    expect(html).toContain("User: ");
    expect(html).not.toContain("k2b-chat-message__bubble");
  });

  test("renders an attachment destination without coupling chat to an application router", () => {
    const html = renderToString(() =>
      createComponent(Chat.Message, {
        role: "user",
        attachments: [{ id: "draft", name: "Quarterly update", kind: "resource", href: "/app/mail/drafts/D4F7K2" }],
      }),
    );

    expect(html).toContain('href="/app/mail/drafts/D4F7K2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Open Quarterly update in a new tab"');
    expect(html).toContain("ti ti-link");
    expect(html).toContain("Quarterly update");
  });

  test("renders a generic timeline without application protocols", () => {
    const html = renderToString(() =>
      createComponent(Chat.Timeline, {
        label: "Support conversation",
        items: [
          { kind: "message", id: "one", role: "user", content: "Hello" },
          {
            kind: "activity",
            id: "two",
            label: "Searching",
            description: "Documentation",
            tone: "ai",
            accent: "#2563eb",
            leading: "Documentation icon",
            busy: true,
          },
          {
            kind: "message",
            id: "three",
            role: "assistant",
            content: "How can I help?",
          },
        ],
      }),
    );

    expect(html).toContain('aria-label="Support conversation"');
    expect(html).toContain('role="log"');
    expect(html).toContain("Hello");
    expect(html).toContain("Searching");
    expect(html).toContain("Documentation icon");
    expect(html).toContain("--k2b-chat-activity-accent:#2563eb");
    expect(html).toContain('data-busy="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("k2b-chat-progress-dots");
    expect(html).toContain("How can I help?");
    expect(html).not.toContain("AiStoredMessage");
  });

  test("renders application navigation outside the conversation live region", () => {
    const html = renderToString(() =>
      createComponent(Chat.Timeline, {
        items: [{ kind: "message", id: "one", role: "user", content: "Hello" }],
        navigation: "Turn navigation",
      }),
    );

    expect(html).toContain("k2b-chat-timeline__navigation");
    expect(html.indexOf("Turn navigation")).toBeLessThan(html.indexOf('role="log"'));
  });

  test("renders the empty state and formats compact token values", () => {
    const html = renderToString(() =>
      createComponent(Chat.Timeline, {
        items: [],
        emptyTitle: "Ask the workspace",
        emptyDescription: "Messages stay in this project.",
      }),
    );

    expect(html).toContain("Ask the workspace");
    expect(html).toContain("Messages stay in this project.");
    expect(formatChatTokens(1_250)).toBe("1.3k");
    expect(formatChatTokens(2_500_000)).toBe("2.5M");
  });

  test("keeps the context trigger honest when no usage was reported", () => {
    const withoutUsage = renderToString(() => createComponent(Chat.ContextUsage, { contextWindow: 128_000 }));
    const withUsage = renderToString(() =>
      createComponent(Chat.ContextUsage, {
        usage: { input: 120_000, output: 4_000 },
        contextWindow: 128_000,
      }),
    );

    expect(withoutUsage).toContain("Context usage unavailable, 128,000 token context window");
    expect(withoutUsage).toContain("<span>–</span>");
    expect(withoutUsage).not.toContain("Remaining");
    expect(withoutUsage).not.toContain('data-warning="true"');
    expect(withUsage).toContain('data-warning="true"');
    expect(withUsage).toContain("124,000 tokens used, 97% of the context window");
  });

  test("omits context usage from the composer until context pressure is known", () => {
    const unavailable = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        contextUsage: { contextWindow: 128_000 },
      }),
    );
    const available = renderToString(() =>
      createComponent(Chat.Composer, {
        value: "",
        onValueChange: () => undefined,
        onSubmit: () => undefined,
        contextUsage: { usage: { total: 0 }, contextWindow: 128_000 },
      }),
    );

    expect(unavailable).not.toContain("k2b-chat-context");
    expect(available).toContain("k2b-chat-context");
    expect(available).toContain("0%");
  });

  test("normalizes explicit zero and invalid context usage without leaking non-finite values", () => {
    const zero = renderToString(() =>
      createComponent(Chat.ContextUsage, {
        usage: { input: 0, output: 0, total: 0 },
        contextWindow: 8_000,
      }),
    );
    const invalid = renderToString(() =>
      createComponent(Chat.ContextUsage, {
        usage: { input: Number.NaN, output: Number.POSITIVE_INFINITY, total: -1 },
        contextWindow: 8_000,
      }),
    );

    expect(zero).toContain("0 tokens used, 0% of the context window");
    expect(zero).toContain("8,000");
    expect(invalid).toContain("Context usage unavailable, 8,000 token context window");
    expect(invalid).not.toMatch(/NaN|Infinity|-1/);
  });

  test("lets the host localize usage without making the default locale-dependent", () => {
    const localized = renderToString(() =>
      createComponent(Chat.ContextUsage, {
        usage: { total: 1_250 },
        contextWindow: 8_000,
        formatNumber: (value: number) => `n:${value}`,
      }),
    );

    expect(formatChatTokens(999)).toBe("999");
    expect(localized).toContain("n:1250 tokens used");
    expect(localized).toContain("n:8000");
  });

  test("offers a keyboard reachable history control only while more history exists", () => {
    const items = [
      {
        kind: "message" as const,
        id: "one",
        role: "user" as const,
        content: "Hello",
      },
    ];
    const withHistory = renderToString(() =>
      createComponent(Chat.Timeline, {
        items,
        hasMore: true,
        onLoadOlder: () => undefined,
      }),
    );
    const loadingHistory = renderToString(() =>
      createComponent(Chat.Timeline, {
        items,
        hasMore: true,
        loadingOlder: true,
        onLoadOlder: () => undefined,
      }),
    );
    const exhausted = renderToString(() =>
      createComponent(Chat.Timeline, {
        items,
        hasMore: false,
        onLoadOlder: () => undefined,
      }),
    );
    const uncontrolled = renderToString(() => createComponent(Chat.Timeline, { items }));

    expect(withHistory).toContain("Load older messages");
    expect(withHistory).toContain('class="k2b-chat-timeline__viewport"');
    expect(withHistory).toContain('role="region"');
    expect(withHistory).toContain('aria-label="Conversation messages"');
    expect(withHistory).toContain('tabindex="0"');
    expect(loadingHistory).toContain("Loading older messages");
    expect(loadingHistory).not.toContain("Load older messages");
    expect(exhausted).not.toContain("Load older messages");
    expect(uncontrolled).not.toContain("Load older messages");
    expect(uncontrolled).not.toContain("k2b-chat-timeline__history");
  });

  test("keeps history controls out of the conversation live region announcements", () => {
    const html = renderToString(() =>
      createComponent(Chat.Timeline, {
        items: [
          {
            kind: "message" as const,
            id: "one",
            role: "user" as const,
            content: "Hi",
          },
        ],
        hasMore: true,
        onLoadOlder: () => undefined,
      }),
    );

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="off"');
    expect(html.indexOf('aria-live="polite"')).toBeLessThan(html.indexOf('aria-live="off"'));
  });

  test("keeps the chat family free of application protocol vocabulary", async () => {
    const sources = [
      "ChatComposer.tsx",
      "ChatPrimitives.tsx",
      "ChatRoot.tsx",
      "ChatTimeline.tsx",
      "chat-behavior.ts",
      "index.ts",
      "types.ts",
    ];
    const forbidden = /\b(session|approval|permission|persistence|persisted|AiStoredMessage|AiActiveTurn|useNavigate)\b/i;

    for (const file of sources) {
      const source = await Bun.file(resolve(import.meta.dir, file)).text();
      expect(source, file).not.toMatch(forbidden);
      expect(source, file).not.toMatch(/from\s+"(?:@valentinkolb\/cloud|.*\/cloud\/)/);
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        expect(match[1], `${file} imports ${match[1]}`).not.toContain("../../");
      }
    }
  });

  test("routes pasted files through the generic file seam and leaves other paste policy to the host", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "ChatComposer.tsx")).text();

    expect(source).toContain("clipboardData?.files.length");
    expect(source).toContain("void runFiles(clipboardData.files)");
    expect(source).toContain("props.onPaste?.(event)");
    expect(source).toContain("props.value;");
    expect(source).toContain("queueMicrotask(autoResize)");
    expect(source).not.toContain("CloudResource");
  });

  test("does not retain the superseded experimental ai surface", async () => {
    const manifest = await Bun.file(resolve(import.meta.dir, "../../package.json")).json();
    const barrel = await Bun.file(resolve(import.meta.dir, "../index.ts")).text();
    const aiRoot = resolve(import.meta.dir, "../ai");

    expect(!existsSync(aiRoot) || readdirSync(aiRoot).length === 0).toBe(true);
    expect(manifest.files).not.toContain("!src/ai/**");
    expect(barrel).not.toContain('"./ai"');
  });

  test("focuses the composer as one AI-themed surface", () => {
    const css = readFileSync(resolve(import.meta.dir, "../styles/index.css"), "utf8");
    const attachmentActionRule = css.match(/\.k2b-ui \.k2b-chat-composer__attachment-action \{([^}]+)\}/)?.[1] ?? "";
    const attachmentIconRule = css.match(
      /\.k2b-ui \.k2b-chat-composer__attachment > i,([\s\S]+?)\.k2b-ui \.k2b-chat-message__attachment > i \{([^}]+)\}/,
    );

    expect(css).toContain("--k2b-ai-accent:");
    expect(css).toContain(".k2b-ui .k2b-chat-composer:focus-within");
    expect(css).toContain("border-color: var(--k2b-ai-border);");
    expect(css).toContain("border-radius: calc(var(--k2b-radius-surface) + 0.25rem);");
    expect(css).toContain("box-shadow: var(--k2b-shadow-surface);");
    expect(css).toContain("max-height: 19.3125rem;");
    expect(css).toContain("overflow-x: auto;");
    expect(css).toContain("flex-wrap: nowrap;");
    expect(css).toContain("grid-row: 1 / 3;");
    expect(attachmentActionRule).toContain("text-decoration: none;");
    expect(attachmentIconRule?.[1]).toContain(".k2b-chat-composer__attachment-identity > i");
    expect(attachmentIconRule?.[2]).toContain("display: inline-flex;");
    expect(attachmentIconRule?.[2]).toContain("font-size: 1rem;");
    expect(css).not.toContain("--k2b-ai-focus-ring");
    expect(css).not.toContain(".k2b-ui .k2b-chat-composer textarea:focus-visible");
  });

  test("renders the minimal shared streaming indicator", () => {
    const css = readFileSync(resolve(import.meta.dir, "../styles/index.css"), "utf8");
    const dotsRule = css.match(/\.k2b-ui \.k2b-chat-progress-dots > span \{([^}]+)\}/)?.[1] ?? "";
    const assistantMessageRule = css.match(/\.k2b-ui \.k2b-chat-message\[data-role="assistant"\] \{([^}]+)\}/)?.[1] ?? "";
    const activityRule = css.match(/\.k2b-ui \.k2b-chat-activity \{([^}]+)\}/)?.[1] ?? "";

    expect(assistantMessageRule).toContain("width: 100%;");
    expect(activityRule).toContain("min-width: 0;");
    expect(activityRule).toContain("width: 100%;");
    expect(activityRule).toContain("max-width: 100%;");
    expect(dotsRule).toContain("width: 0.3rem;");
    expect(dotsRule).toContain("height: 0.3rem;");
    expect(dotsRule).toContain("animation: k2b-chat-dot-pulse 1s ease-in-out infinite;");
    expect(css).toContain("@keyframes k2b-chat-dot-pulse");
    expect(css).toContain(".k2b-ui .k2b-chat-message__status--streaming");
  });

  test("uses a text-color shimmer instead of a color pulse for busy activities", () => {
    const css = readFileSync(resolve(import.meta.dir, "../styles/index.css"), "utf8");

    expect(css).toContain('.k2b-chat-activity[data-busy="true"]:not([data-tone="success"]):not([data-tone="danger"])');
    expect(css).toContain("color-mix(in srgb, var(--k2b-chat-activity-busy-color) 48%, transparent)");
    expect(css).toContain("animation: k2b-chat-activity-shimmer 1.7s linear infinite;");
    expect(css).toContain("@keyframes k2b-chat-activity-shimmer");
    expect(css).not.toContain("k2b-chat-activity-accent-sweep");
    expect(css).toContain("color: var(--k2b-chat-activity-busy-color);");
    expect(css).toContain("background-image: none;");
  });

  test("keeps semantic activity tones stronger than an optional identity accent", () => {
    const css = readFileSync(resolve(import.meta.dir, "../styles/index.css"), "utf8");

    expect(css).toContain('.k2b-chat-activity[data-accent="true"]:not([data-tone="success"]):not([data-tone="danger"])');
    expect(css).toContain("var(--k2b-chat-activity-accent) 78%, black");
    expect(css).toContain("var(--k2b-chat-activity-accent) 58%, white");
    expect(css).toContain('.k2b-chat-activity[data-body-inset="false"] > .k2b-chat-activity__body');
  });

  test("leaves spacing after expanded activity bodies to their parent layout", () => {
    const css = readFileSync(resolve(import.meta.dir, "../styles/index.css"), "utf8");
    const bodyRule = css.match(/\.k2b-ui \.k2b-chat-activity__body \{([^}]+)\}/)?.[1] ?? "";

    expect(bodyRule).toContain("padding: 0.375rem 0 0;");
    expect(bodyRule).not.toContain("padding: 0.375rem 0 0.625rem;");
  });
});
