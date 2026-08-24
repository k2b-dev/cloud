import { afterEach, describe, expect, test } from "bun:test";
import { launchMailDraftAssistant } from "./mail-assistant-launch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const contact = (index: number, matchedEmail: string) => {
  const contactId = `Ct${String(index).padStart(4, "0")}`;
  const bookId = "Bk0001";
  return {
    contactId,
    bookId,
    bookName: "Contacts",
    displayName: `Contact ${index}`,
    companyName: null,
    jobTitle: null,
    matchedEmails: [matchedEmail],
    emails: [{ label: "work", email: matchedEmail }],
    phones: [],
    contactPointsTruncated: false,
    updatedAt: "2026-08-18T12:00:00.000Z",
    links: [{ rel: "open", href: `/app/contacts/${bookId}?contact=${contactId}&contactBook=${bookId}` }],
  };
};

const draft = (addresses: string[]) => ({
  id: "Drf001",
  subject: "Quarterly update",
  to: addresses.map((address) => ({ address })),
  cc: [],
  bcc: [],
});

const conversation = {
  id: "Cht001",
  draft: { content: [], revision: 1, updatedAt: null },
};

describe("Mail Assistant launch", () => {
  test("launches with the draft, exact unique contacts, canonical links, and useful tools", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        calls.push([path, init]);
        if (path.includes("/capabilities/v1/queries/contacts/contact.resolve")) {
          return Response.json({
            data: { items: [contact(1, "ada@example.test")], matchedEmails: ["ada@example.test"] },
            page: { hasMore: false },
          });
        }
        return Response.json(conversation, { status: 201 });
      },
      { preconnect: originalFetch.preconnect },
    );

    const launch = await launchMailDraftAssistant({
      mailboxId: "Box001",
      returnHref: "/app/mail/Box001?conversation=Msg001",
      draft: draft(["Ada@Example.Test"]),
    });

    expect(launch.href).toBe("/app/assistant?conversation=Cht001");
    expect(calls.map(([path]) => path)).toEqual(["/api/capabilities/v1/queries/contacts/contact.resolve", "/api/ai/conversations"]);
    expect(calls[0]?.[1]?.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      input: { emails: ["ada@example.test"], limit: 50 },
    });
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      launchedByAppId: "mail",
      title: "Quarterly update",
      draft: {
        content: [
          { type: "text", text: "Help me write this email." },
          {
            type: "resource",
            ref: { type: "mail.draft", id: "Drf001" },
            title: "Quarterly update",
            icon: "ti ti-file-pencil",
            href: "/app/mail/Box001/compose/Drf001?return=%2Fapp%2Fmail%2FBox001%3Fconversation%3DMsg001",
          },
          {
            type: "resource",
            ref: { type: "contacts.contact", id: "Ct0001" },
            title: "Contact 1",
            icon: "ti ti-address-book",
            href: "/app/contacts/Bk0001?contact=Ct0001&contactBook=Bk0001",
          },
        ],
      },
      preloadTools: [
        { name: "text_editor" },
        { appId: "mail", kind: "query", id: "draft.read" },
        { appId: "mail", kind: "action", id: "draft.update" },
        { appId: "mail", kind: "action", id: "draft.send" },
        { appId: "mail", kind: "query", id: "conversation.search" },
        { appId: "mail", kind: "query", id: "conversation.related" },
        { appId: "contacts", kind: "query", id: "contact.resolve" },
      ],
    });
  });

  test("does not attach an ambiguous contact", async () => {
    let launchBody = "";
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        if (String(request).includes("contact.resolve")) {
          return Response.json({
            data: {
              items: [contact(1, "shared@example.test"), contact(2, "shared@example.test")],
              matchedEmails: ["shared@example.test"],
            },
            page: { hasMore: false },
          });
        }
        launchBody = String(init?.body);
        return Response.json(conversation, { status: 201 });
      },
      { preconnect: originalFetch.preconnect },
    );

    await launchMailDraftAssistant({ mailboxId: "Box001", returnHref: "/app/mail/Box001", draft: draft(["shared@example.test"]) });

    const launchPayload = JSON.parse(launchBody);
    expect(launchPayload).toMatchObject({
      draft: { content: [{ type: "text" }, { type: "resource", ref: { type: "mail.draft" } }] },
    });
    expect(launchPayload.draft.content).toHaveLength(2);
  });

  test("launches without Contact context when Contacts is unavailable", async () => {
    let launchBody = "";
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        if (String(request).includes("contact.resolve")) throw new Error("Contacts unavailable");
        launchBody = String(init?.body);
        return Response.json(conversation, { status: 201 });
      },
      { preconnect: originalFetch.preconnect },
    );

    await launchMailDraftAssistant({ mailboxId: "Box001", returnHref: "/app/mail/Box001", draft: draft(["ada@example.test"]) });

    const launchPayload = JSON.parse(launchBody);
    expect(launchPayload.draft.content).toHaveLength(2);
    expect(
      launchPayload.preloadTools.filter((tool: { appId?: string }) => tool.appId).map(({ appId }: { appId: string }) => appId),
    ).toEqual(["mail", "mail", "mail", "mail", "mail"]);
  });

  test("bounds recipient resolution and attached Contact resources", async () => {
    const recipients = Array.from({ length: 30 }, (_, index) => `person-${index + 1}@example.test`);
    const resolvedEmails = recipients.slice(0, 25);
    let resolutionBody = "";
    let launchBody = "";
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        if (String(request).includes("contact.resolve")) {
          resolutionBody = String(init?.body);
          return Response.json({
            data: {
              items: resolvedEmails.map((email, index) => contact(index + 1, email)),
              matchedEmails: resolvedEmails,
            },
            page: { hasMore: false },
          });
        }
        launchBody = String(init?.body);
        return Response.json(conversation, { status: 201 });
      },
      { preconnect: originalFetch.preconnect },
    );

    await launchMailDraftAssistant({ mailboxId: "Box001", returnHref: "/app/mail/Box001", draft: draft(recipients) });

    expect(JSON.parse(resolutionBody)).toEqual({ input: { emails: resolvedEmails, limit: 50 } });
    expect(
      JSON.parse(launchBody).draft.content.filter((part: { ref?: { type: string } }) => part.ref?.type === "contacts.contact"),
    ).toHaveLength(5);
  });
});
