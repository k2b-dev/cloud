// Test subprocess only. Its own parent provides an isolated CLOUD_TEST_DATABASE_URL.
import { SQL } from "bun";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import { requireDatabaseUrl } from "../../../scripts/fixtures/test-infra";
import { message, updateFrame } from "../protocol";
import { NotesService } from "./service";
import { NotesStore } from "./store";

const db = new SQL(requireDatabaseUrl());
const token = process.env.NOTES_TEST_EDIT_ID;
if (!token) throw new Error("test_token_missing");
const service = new NotesService(new NotesStore(db, 1024 ** 3), { storageBytes: 1024 ** 3, maxConnections: 100, maxOpenPads: 100 });
await service.start();
try {
  const current = await service.read(token);
  const doc = new Y.Doc();
  doc.clientID = 127;
  Y.applyUpdate(doc, Buffer.from(current.snapshot, "base64"));
  const vector = Y.encodeStateVector(doc);
  doc.getText("text").insert(doc.getText("text").length, " crash-safe");
  const connection = await service.admit(token, "127.0.0.1");
  await service.attach(connection, {
    send(bytes) {
      if (decoding.readVarUint(decoding.createDecoder(bytes)) === message.ack && process.env.NOTES_TEST_CRASH === "ack")
        process.kill(process.pid, "SIGKILL");
    },
    close() {},
    bufferedAmount: () => 0,
  });
  await service.receive(connection, updateFrame("crash-update", Y.encodeStateAsUpdate(doc, vector)));
  await service.compact(current.readId);
  doc.destroy();
} finally {
  await service.stop();
  await db.close();
}
