import { describe, expect, test } from "bun:test";
import { MAIL_SEARCH_PARAMETER, parseMailSearchState, serializeMailSearchState } from "../../search-state";
import { MAX_MAIL_WORKSPACE_HREF_LENGTH } from "../../search-url";
import {
  buildExactParticipantSearchHref,
  buildExactSenderSearchHref,
  buildMailAttachmentDownloadHref,
  buildMailingListHref,
  buildMailListHref,
  buildMailSearchClearHref,
  buildMailSearchHref,
  buildMailSelectionHref,
  isMailListItemActive,
  isMailWorkspaceUrl,
  type MailListItem,
  mailRouteUrl,
  resolveMailWorkspaceUrl,
  senderDomainFromAddress,
} from "./mail-navigation";

const item: MailListItem = {
  id: "Msg001",
  conversationId: "Conv01",
  selectionKind: "conversation",
  primaryReference: null,
  subject: "Subject",
  participantSummary: "Sender",
  participantLabels: ["Sender"],
  latestMessageAt: "2026-07-20T00:00:00.000Z",
  preview: null,
  attachmentMatch: null,
  unread: false,
  activeFolderIds: [],
  flagged: false,
  hasAttachments: false,
  messageCount: 1,
  workStatus: "needs_action",
  assigneeUserIds: [],
  snoozedUntil: null,
  sourceFolderId: null,
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
  kept: false,
};

describe("Mail search navigation", () => {
  test("preserves structured search while selecting a conversation", () => {
    const serialized = serializeMailSearchState({
      expression: {
        type: "text",
        field: "subject",
        query: "invoice",
        match: "words",
      },
      sort: "newest",
    });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const url = new URL("https://cloud.example/app/mail/Box001");
    url.searchParams.set(MAIL_SEARCH_PARAMETER, serialized.value);

    const selected = new URL(buildMailSelectionHref(url, item), url.origin);
    expect(selected.searchParams.get(MAIL_SEARCH_PARAMETER)).toBe(serialized.value);
    expect(selected.searchParams.get("conversation")).toBe(item.conversationId);
  });

  test("clears all current and legacy search state without changing the active mailbox view", () => {
    const url = new URL(
      "https://cloud.example/app/mail/Box001?folder=Fold01&q=x&qFields=from%2Cbody&search=%7B%7D&subject=y&combine=all&cursor=next&conversation=Conv01",
    );
    const cleared = new URL(buildMailListHref(url, true), url.origin);
    expect(cleared.searchParams.get("folder")).toBe("Fold01");
    expect(cleared.searchParams.has("q")).toBe(false);
    expect(cleared.searchParams.has("qFields")).toBe(false);
    expect(cleared.searchParams.has(MAIL_SEARCH_PARAMETER)).toBe(false);
    expect(cleared.searchParams.has("subject")).toBe(false);
    expect(cleared.searchParams.has("combine")).toBe(false);
    expect(cleared.searchParams.has("cursor")).toBe(false);
    expect(cleared.searchParams.has("conversation")).toBe(false);
  });

  test("derives the active row from the current conversation or message selection", () => {
    expect(isMailListItemActive(item, item.conversationId, null)).toBe(true);
    expect(isMailListItemActive(item, "Conv02", null)).toBe(false);
    expect(isMailListItemActive({ ...item, conversationId: null, selectionKind: "message" }, null, item.id)).toBe(true);
  });

  test("keeps conversation context while selecting one row in message view", () => {
    const messageItem = { ...item, selectionKind: "message" as const };
    const href = new URL(buildMailSelectionHref(new URL("https://cloud.example/app/mail/mailbox"), messageItem), "https://cloud.example");
    expect(href.searchParams.get("conversation")).toBe(item.conversationId);
    expect(href.searchParams.get("message")).toBe(item.id);
    expect(isMailListItemActive(messageItem, item.conversationId, item.id)).toBe(true);
  });

  test("opens and downloads the exact message attachment that matched", () => {
    const attachmentItem: MailListItem = {
      ...item,
      attachmentMatch: {
        attachmentId: "Attach1",
        messageId: "Msg002",
        filename: "roadmap.pdf",
        snippet: "roadmap milestone",
        reason: "attachment_content",
      },
    };
    const url = new URL("https://cloud.example/app/mail/Box001?q=roadmap");

    const selected = new URL(buildMailSelectionHref(url, attachmentItem), url.origin);
    expect(selected.searchParams.get("conversation")).toBe(item.conversationId);
    expect(selected.searchParams.get("message")).toBe("Msg002");
    expect(buildMailAttachmentDownloadHref(url, attachmentItem)).toBe("/api/mail/mailboxes/Box001/messages/Msg002/attachments/Attach1");
    expect(buildMailAttachmentDownloadHref(new URL("https://cloud.example/app/mail/Box001/automations"), attachmentItem)).toBeNull();
  });

  test("builds an exact URL-backed sender search and normalizes a usable domain", () => {
    const url = new URL("https://cloud.example/app/mail/Box001?folder=Fold01&q=old&conversation=Conv01");
    const href = buildExactSenderSearchHref(url, "Sender+news@Sub.Example.com");
    expect(href).not.toBeNull();
    const next = new URL(href!, url.origin);

    expect(next.searchParams.has("folder")).toBe(false);
    expect(next.searchParams.get("searchFrom")).toBe("folder=Fold01&conversation=Conv01");
    expect(next.searchParams.has("q")).toBe(false);
    expect(next.searchParams.has("conversation")).toBe(false);
    expect(parseMailSearchState(next)).toEqual({
      state: {
        expression: { type: "text", field: "from", query: "Sender+news@Sub.Example.com", match: "exact" },
        sort: "newest",
      },
      error: null,
    });
    expect(senderDomainFromAddress("Sender+news@Sub.Example.com")).toBe("sub.example.com");
    expect(senderDomainFromAddress("invalid")).toBeNull();
  });

  test("builds an exact URL-backed participant search for related Mail", () => {
    const url = new URL("https://cloud.example/app/mail/Box001?folder=Fold01&q=old&conversation=Conv01");
    const href = buildExactParticipantSearchHref(url, "Person@Example.com");
    expect(href).not.toBeNull();
    const next = new URL(href!, url.origin);

    expect(next.searchParams.has("folder")).toBe(false);
    expect(next.searchParams.get("searchFrom")).toBe("folder=Fold01&conversation=Conv01");
    expect(next.searchParams.has("q")).toBe(false);
    expect(next.searchParams.has("conversation")).toBe(false);
    expect(parseMailSearchState(next)).toEqual({
      state: {
        expression: { type: "text", field: "participants", query: "Person@Example.com", match: "exact" },
        sort: "newest",
      },
      error: null,
    });
  });
});

test("adds a focused mailing list without dropping the mailbox context", () => {
  const href = buildMailingListHref(new URL("https://cloud.example/app/mail/Box001?folder=Fold01&conversation=Conv01"), "list one&two");
  expect(href).toBe("/app/mail/Box001?folder=Fold01&conversation=Conv01&mailingList=list+one%26two");
});

describe("Mail workspace route ownership", () => {
  const origin = "https://cloud.example";
  const mailboxId = "Box001";

  test("owns query and selection changes on the current mailbox route", () => {
    expect(isMailWorkspaceUrl(new URL(`/app/mail/${mailboxId}?view=mine`, origin), mailboxId, origin)).toBe(true);
    expect(isMailWorkspaceUrl(new URL(`/app/mail/${mailboxId}?conversation=Conv01`, origin), mailboxId, origin)).toBe(true);
  });

  test("keeps the SSR route usable when the upstream origin differs from the public one", () => {
    // Behind the gateway the page renders from http://app-mail:3000 while the browser is on the public
    // origin; the page therefore serializes requestPath(c), i.e. pathname + search.
    const upstream = new URL(`http://app-mail:3000/app/mail/${mailboxId}?view=needs_action`);
    const route = `${upstream.pathname}${upstream.search}`;
    const firstPage = resolveMailWorkspaceUrl(route, mailboxId, origin);
    expect(firstPage?.href).toBe(`${origin}/app/mail/${mailboxId}?view=needs_action`);
    // Page two and a live refresh derive from the same route source.
    const secondPage = new URL(firstPage!);
    secondPage.searchParams.set("cursor", "page-2");
    expect(isMailWorkspaceUrl(secondPage, mailboxId, origin)).toBe(true);
    expect(resolveMailWorkspaceUrl(`${firstPage!.pathname}${firstPage!.search}`, mailboxId, origin)?.href).toBe(firstPage!.href);
    // The absolute upstream URL that used to be serialized is still rejected by the same guard.
    expect(resolveMailWorkspaceUrl(`http://app-mail:3000/app/mail/${mailboxId}?view=needs_action`, mailboxId, origin)).toBeNull();
    expect(resolveMailWorkspaceUrl("/app/mail/Box002", mailboxId, origin)).toBeNull();
  });

  test("route helpers parse a path and never leak the placeholder origin", () => {
    const url = mailRouteUrl(`/app/mail/${mailboxId}?view=mine&conversation=Conv01`);
    expect(url.searchParams.get("conversation")).toBe("Conv01");
    expect(buildMailListHref(url)).toBe(`/app/mail/${mailboxId}?view=mine`);
    expect(buildMailSelectionHref(url, item)).toBe(`/app/mail/${mailboxId}?view=mine&conversation=Conv01`);
  });

  test("leaves server-rendered Mail pages and other origins to document navigation", () => {
    for (const href of [
      "/app/mail",
      "/app/mail/compose",
      `/app/mail/${mailboxId}/automations`,
      "/app/mail/Box002",
      "https://other.example/app/mail/Box001",
    ]) {
      expect(isMailWorkspaceUrl(new URL(href, origin), mailboxId, origin)).toBe(false);
    }
  });
});

describe("Mail search origin", () => {
  const path = "/app/mail/Box001";
  const url = (query: string) => new URL(`${path}${query ? `?${query}` : ""}`, "https://cloud.example");
  const origins = ["view=needs_action", "folder=Fold01", "savedView=Saved1", "scheduled=1", "search=tag+filter", ""];

  for (const origin of origins) {
    test(`records and restores ${origin || "All mail"} with its selection`, () => {
      const selection = "conversation=Conv01&message=Msg001";
      const expectedOrigin = [origin, selection].filter(Boolean).join("&");
      const source = url(`${expectedOrigin}&cursor=page-2&mailingList=list&q=old&qFields=body`);
      const searched = new URL(buildMailSearchHref(source, { q: "invoice" }), source.origin);
      expect(searched.searchParams.get("searchFrom")).toBe(expectedOrigin);
      expect(searched.searchParams.get("q")).toBe("invoice");
      for (const name of ["view", "folder", "savedView", "scheduled", "search", "conversation", "message", "cursor", "qFields"])
        expect(searched.searchParams.has(name)).toBe(false);
      expect(buildMailSearchClearHref(searched)).toBe(`${path}?${expectedOrigin}`);
    });
  }

  test("records a present, empty origin for All mail and keeps it during refinements", () => {
    const first = buildMailSearchHref(url(""), { q: "one" });
    expect(first).toBe(`${path}?searchFrom=&q=one`);
    const refined = buildMailSearchHref(new URL(first, "https://cloud.example"), { q: "two", qFields: "body" });
    expect(refined).toBe(`${path}?searchFrom=&q=two&qFields=body`);
    expect(buildMailSearchClearHref(new URL(refined, "https://cloud.example"))).toBe(path);
  });

  test("takes first values in the view parameter order", () => {
    const searched = buildMailSearchHref(
      url("message=m&conversation=c&search=tag&scheduled=1&savedView=s&folder=f&view=needs_action&view=done&folder=other"),
      { q: "one" },
    );
    expect(new URL(searched, "https://cloud.example").searchParams.get("searchFrom")).toBe(
      "view=needs_action&folder=f&savedView=s&scheduled=1&search=tag&conversation=c&message=m",
    );
  });

  test("keeps an existing origin when refining, switching to the builder, or saving a search", () => {
    const source = url("q=old&conversation=result&searchFrom=view%3Dneeds_action%26conversation%3Doriginal");
    const searches: Record<string, string>[] = [{ q: "new" }, { search: "structured" }, { savedView: "Saved1" }];
    for (const search of searches) {
      const next = new URL(buildMailSearchHref(source, search), source.origin);
      expect(next.searchParams.get("searchFrom")).toBe("view=needs_action&conversation=original");
      expect(buildMailSearchClearHref(next)).toBe(`${path}?view=needs_action&conversation=original`);
    }
  });

  test("drops a starting filter that would push the search past the workspace route limit", () => {
    const source = url("view=needs_action");
    source.searchParams.set("search", JSON.stringify({ query: '"'.repeat(1_000) }));
    const href = buildMailSearchHref(source, { search: "structured" });
    expect(href.length).toBeLessThanOrEqual(MAX_MAIL_WORKSPACE_HREF_LENGTH);
    expect(new URL(href, source.origin).searchParams.get("searchFrom")).toBe("view=needs_action");
    const small = url("view=needs_action&search=tag");
    expect(new URL(buildMailSearchHref(small, { search: "structured" }), source.origin).searchParams.get("searchFrom")).toBe(
      "view=needs_action&search=tag",
    );
  });

  test("filters a hand-edited origin and restores only first allowed values", () => {
    const source = url("q=invoice&mailingList=current");
    source.searchParams.set(
      "searchFrom",
      "q=leak&cursor=next&searchFrom=nested&unknown=no&message=m&view=needs_action&view=done&conversation=c",
    );
    expect(buildMailSearchClearHref(source)).toBe(`${path}?view=needs_action&conversation=c&message=m`);
  });

  test("falls back to the existing clear behavior for links without an origin", () => {
    const source = url("folder=f&q=old&qFields=body&cursor=next&conversation=c&search=old");
    expect(buildMailSearchClearHref(source)).toBe(buildMailListHref(source, true));
  });

  test("keeps the origin when selecting and closing results but removes it when clearing the list", () => {
    const source = url("q=one&searchFrom=view%3Dneeds_action");
    const selected = new URL(buildMailSelectionHref(source, item), source.origin);
    expect(selected.searchParams.get("searchFrom")).toBe("view=needs_action");
    expect(new URL(buildMailListHref(selected), source.origin).searchParams.get("searchFrom")).toBe("view=needs_action");
    expect(new URL(buildMailListHref(selected, true), source.origin).searchParams.has("searchFrom")).toBe(false);
  });
});
