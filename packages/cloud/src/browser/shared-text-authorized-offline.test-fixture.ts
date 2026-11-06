import * as Y from "yjs";
import { logoutSharedTextOffline, openSharedTextOffline } from "./shared-text-offline";
import { openAuthorizedSharedTextOffline } from "./shared-text-offline-authorized";

const identity = { userId: "fixture-user", draftId: "fixture-draft", generation: "1" };
const duringAuthorization = async (silent: boolean) => {
  const initial = await openSharedTextOffline(identity);
  const doc = new Y.Doc();
  doc.clientID = 101;
  doc.getText("codemirror").insert(0, "pending local input");
  await initial.save(Y.encodeStateAsUpdate(doc));
  initial.close();
  doc.destroy();
  const post = BroadcastChannel.prototype.postMessage;
  if (silent) BroadcastChannel.prototype.postMessage = () => {};
  let rejected = false;
  try {
    const old = await openAuthorizedSharedTextOffline(identity, async () => {
      // The server's prior authorization response arrives after a local logout.
      await logoutSharedTextOffline(identity.userId);
      return "old authorized response";
    });
    old.session.close();
  } catch {
    rejected = true;
  } finally {
    BroadcastChannel.prototype.postMessage = post;
  }
  const fresh = await openAuthorizedSharedTextOffline(identity, async () => "new authenticated request");
  const empty = fresh.state === null;
  fresh.session.close();
  return { rejected, empty };
};
const refused = async () => {
  let rejected = false;
  try {
    await openAuthorizedSharedTextOffline(identity, async () => {
      throw new Error("Not authorized");
    });
  } catch {
    rejected = true;
  }
  // A closed, refused request must not keep a database upgrade blocked.
  const removed = await new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("cloud-shared-text-offline");
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(false);
  });
  return { rejected, removed };
};
declare global {
  interface Window {
    offlineAuthorizationTest: { duringAuthorization: typeof duringAuthorization; refused: typeof refused };
  }
}
window.offlineAuthorizationTest = { duringAuthorization, refused };
