import { describe, expect, test } from "bun:test";
import {
  AI_COMPOSER_TEXT_MAX_CHARS,
  AI_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  type AiComposerAttachment,
  aiChatAttachments,
  aiChatModelOptions,
  aiComposerAttachmentRecords,
  aiComposerFileAccept,
  aiComposerSendInput,
  aiComposerDraft,
  createAiPastedTextFile,
  readAiComposerFiles,
  shouldAttachAiPastedText,
} from "./composer-adapter";

describe("Cloud chat composer adapter", () => {
  test("round-trips ordered Skill, file and Project file mentions through a saved draft", () => {
    const content = [
      { type: "text" as const, text: "Use " },
      { type: "resource" as const, inline: true, ref: { type: "core.ai.skill", id: "Sk2345" }, title: "Invoices", icon: "ti ti-sparkles" },
      { type: "text" as const, text: " with " },
      { type: "file" as const, inline: true, path: "/bill.pdf", mediaType: "application/pdf", size: 12, version: 4 },
      { type: "text" as const, text: " and " },
      { type: "project-file" as const, inline: true, path: "/project/rules.md" },
    ];
    const draft = aiComposerDraft(content);
    expect(draft.text).toBe("Use Invoices with bill.pdf and /project/rules.md");
    expect(draft.mentions).toHaveLength(3);
    const serialized = aiComposerSendInput({ intent: "queue", text: draft.text, mentions: draft.mentions, attachments: aiChatAttachments(draft.attachments) });
    expect(serialized.draftContent).toEqual(content);
    expect(serialized.resources).toBeUndefined();
  });
  test("promotes long or overflowing pasted text to one plain-text file", () => {
    expect(shouldAttachAiPastedText("short", 0)).toBe(false);
    expect(shouldAttachAiPastedText("x".repeat(AI_PASTED_TEXT_ATTACHMENT_THRESHOLD), 0)).toBe(true);
    expect(shouldAttachAiPastedText("extra", AI_COMPOSER_TEXT_MAX_CHARS - 2)).toBe(true);
    const file = createAiPastedTextFile("long text");
    expect(file.name).toMatch(/^pasted-[a-f0-9]{8}\.txt$/);
    expect(createAiPastedTextFile("another paste").name).not.toBe(file.name);
    expect({ type: file.type, size: file.size }).toEqual({ type: "text/plain;charset=utf-8", size: 9 });
  });

  test("offers a reversible text-field action for bounded text attachments", () => {
    let selected = "";
    const file = createAiPastedTextFile("long text");
    const [attachment] = aiChatAttachments(
      [
        {
          kind: "file",
          id: "paste",
          name: file.name,
          size: file.size,
          mediaType: file.type,
          file,
          icon: "ti ti-file-text",
        },
      ],
      {
        onShowText: (item) => {
          selected = item.id;
        },
      },
    );

    expect(attachment?.name).toBe("Pasted text");
    expect(attachment?.action?.label).toBe("Show in text field");
    expect(attachment?.icon).toBe("ti ti-file-text");
    if (attachment?.action?.onSelect) attachment.action.onSelect();
    expect(selected).toBe("paste");
  });

  test("keeps pasted text labels stable after older uploads reload", () => {
    const attachment = aiChatAttachments([
      {
        kind: "stored-file",
        id: "stored-paste",
        name: "pasted-text-3.txt",
        path: "/pasted-text-3.txt",
        size: 9,
        mediaType: "text/plain",
        version: 1,
        icon: "ti ti-file-text",
      },
    ])[0];
    const ordinary = aiChatAttachments([
      {
        kind: "stored-file",
        id: "notes",
        name: "notes.txt",
        path: "/notes.txt",
        size: 9,
        mediaType: "text/plain",
        version: 1,
        icon: "ti ti-file-text",
      },
    ])[0];

    expect(attachment?.name).toBe("Pasted text");
    expect(ordinary?.name).toBe("notes.txt");
  });

  test("maps model profiles without leaking the Cloud profile contract", () => {
    expect(
      aiChatModelOptions([
        {
          id: "vision",
          label: "Vision",
          provider: "openrouter",
          model: "test/vision",
          capabilities: ["streaming", "vision"],
          dataBoundary: "private",
          contextWindow: 128_000,
          image: "https://example.test/provider.svg",
        },
      ]),
    ).toEqual([
      {
        id: "vision",
        label: "Vision",
        description: "test/vision",
        image: "https://example.test/provider.svg",
        icon: "ti ti-photo-spark",
        capabilities: ["streaming", "vision"],
      },
    ]);
  });

  test("round-trips application-owned attachment data into the controller input", () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    const image: AiComposerAttachment = {
      kind: "image",
      id: "image",
      name: "photo.png",
      size: 4,
      mediaType: "image/png",
      data: "aW1n",
      file,
    };
    const uploaded: AiComposerAttachment = {
      kind: "file",
      id: "file",
      name: "notes.txt",
      size: file.size,
      mediaType: file.type,
      file,
      icon: "ti-file-text",
    };
    const attachments = aiChatAttachments([image, uploaded]);

    expect(attachments.map((attachment) => attachment.data)).toEqual([image, uploaded]);
    expect(aiComposerAttachmentRecords(attachments)).toEqual([image, uploaded]);
    expect(
      aiComposerSendInput({
        intent: "send",
        text: "Review these",
        attachments,
      }),
    ).toEqual({
      message: "Review these",
      content: [{ type: "text", text: "Review these" }],
      files: [file, file],
    });
  });

  test("round-trips a linked Cloud resource as an attachment without duplicating its icon class", () => {
    const resource: AiComposerAttachment = {
      kind: "resource",
      id: "resource:mail.draft:D4F7K2",
      name: "Quarterly update",
      ref: { type: "mail.draft", id: "D4F7K2" },
      icon: "ti ti-mail",
      href: "/app/mail/drafts/D4F7K2",
    };
    const attachments = aiChatAttachments([resource]);

    expect(attachments).toEqual([
      {
        id: resource.id,
        name: resource.name,
        size: undefined,
        kind: "resource",
        icon: "ti ti-mail",
        previewUrl: undefined,
        href: resource.href,
        data: resource,
      },
    ]);
    expect(aiComposerSendInput({ intent: "send", text: "", attachments })).toEqual({
      message: undefined,
      content: undefined,
      files: undefined,
      resources: [{ ref: resource.ref, title: resource.name, icon: resource.icon, href: resource.href }],
      storedFiles: undefined,
    });
  });

  test("keeps file policy in Cloud and rejects images without a vision path", async () => {
    const result = await readAiComposerFiles([new File(["image"], "photo.png", { type: "image/png" })], { acceptsImages: false });

    expect(aiComposerFileAccept).toContain("image/png");
    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual(["photo.png: choose a Vision model or configure the view_image fallback."]);
  });

  test("accepts every document format supported by read_file", () => {
    const accepted = new Set(aiComposerFileAccept.split(","));

    for (const extension of ["pdf", "doc", "docx", "odt", "ppt", "pptx", "odp", "xlsx", "ods", "rtf", "epub", "csv"]) {
      expect(accepted).toContain(`.${extension}`);
    }
  });

  test("preflights the aggregate image limit across composer selections", async () => {
    const result = await readAiComposerFiles([new File(["image"], "photo.png", { type: "image/png" })], {
      acceptsImages: true,
      currentImageBytes: 40 * 1024 * 1024,
    });
    expect(result.attachments).toEqual([]);
    expect(result.errors[0]).toContain("40 MB total limit");
  });
});
