import { expect, mock, test } from "bun:test";
import {
  connectContactsHead,
  type ContactsHeadState,
  publishContactsHeadState,
  subscribeToContactsHeadChanges,
} from "./contacts-head-events";

const state: ContactsHeadState = {
  source: "/app/contacts",
  requestedSource: "/app/contacts?search=Ada",
  busy: true,
  total: 4,
  filtered: false,
  selectionMode: false,
};

test("head navigates as a document before results answers, then sends changes and selection requests", () => {
  const previous = globalThis.window;
  const assign = mock((_href: string) => {});
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: Object.assign(new EventTarget(), { location: { assign } }),
  });
  const receive = mock((_state: ContactsHeadState) => {});
  const change = mock((_change: { href: string; resetSearch?: boolean }) => {});
  const select = mock(() => {});
  const supersede = mock(() => {});
  const head = connectContactsHead(receive);
  let stop = () => {};
  try {
    head.change({ href: "/app/contacts?tag_id=vip" });
    expect(assign).toHaveBeenCalledWith("/app/contacts?tag_id=vip");
    stop = subscribeToContactsHeadChanges(change, select, () => publishContactsHeadState(state), supersede);
    head.supersede();
    expect(supersede).not.toHaveBeenCalled();
    publishContactsHeadState(state);
    expect(receive).toHaveBeenCalledWith(state);
    head.change({ href: "/app/contacts", resetSearch: true });
    head.toggleSelection();
    head.supersede();
    expect(supersede).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith({ href: "/app/contacts", resetSearch: true });
    expect(select).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    head.dispose();
    publishContactsHeadState(state);
    expect(receive).toHaveBeenCalledTimes(1);
    stop();
    head.supersede();
    expect(supersede).toHaveBeenCalledTimes(1);
  } finally {
    head.dispose();
    stop();
    globalThis.window = previous;
  }
});

test("a head that mounts after results requests and receives the current state immediately", () => {
  const previous = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: new EventTarget() });
  const receive = mock((_state: ContactsHeadState) => {});
  const stop = subscribeToContactsHeadChanges(
    () => {},
    () => {},
    () => publishContactsHeadState(state),
    () => {},
  );
  const head = connectContactsHead(receive);
  try {
    expect(receive).toHaveBeenCalledWith(state);
  } finally {
    head.dispose();
    stop();
    globalThis.window = previous;
  }
});
