import { beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { type ProviderConnectionInput, providerConnectionInputSchema } from "../../contracts";
import type { MailConnector, RemoteMutationTarget } from "./contract";
import { imapSmtpConnector } from "./imap-smtp";

const configPath = process.env.MAIL_CONNECTOR_CONFORMANCE_CONFIG;
const suite = configPath ? describe : describe.skip;

const readStream = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const findUid = async (params: {
  connector: MailConnector;
  config: ProviderConnectionInput;
  folderPath: string;
  messageId: string;
}): Promise<number> => {
  const uids = await params.connector.findMessageById(params.config, params.folderPath, params.messageId);
  const uid = uids.at(-1);
  if (!uid) throw new Error(`Conformance message ${params.messageId} was not found in ${params.folderPath}`);
  return uid;
};

const folderPath = (root: string, delimiter: string, leaf: string): string => {
  const trimmed = root.trim();
  if (!trimmed) return leaf;
  return trimmed.endsWith(delimiter) ? `${trimmed}${leaf}` : `${trimmed}${delimiter}${leaf}`;
};

const exerciseImapContract = async (params: { connector: MailConnector; config: ProviderConnectionInput }): Promise<void> => {
  const verification = await params.connector.verify(params.config);
  expect(verification.authenticatedPrincipal.length).toBeGreaterThan(0);
  expect(verification.accounts.length).toBeGreaterThan(0);

  const initialFolders = await params.connector.discoverFolders(params.config);
  const namespace = verification.accounts.flatMap((account) => account.namespaces).find((entry) => entry.kind === "personal");
  const delimiter = initialFolders.find((folder) => folder.delimiter)?.delimiter ?? namespace?.delimiter ?? "/";
  const personalPrefix = namespace?.prefix ?? "";
  const suffix = crypto.randomUUID().slice(0, 8);
  const sourcePath = folderPath(personalPrefix, delimiter, `Cloud Conformance ${suffix}`);
  const destinationPath = folderPath(personalPrefix, delimiter, `Cloud Conformance ${suffix} Copy`);
  const renamedPath = folderPath(personalPrefix, delimiter, `Cloud Conformance ${suffix} Moved`);
  const messageId = `<cloud-mail-conformance-${suffix}@example.invalid>`;
  const source = Buffer.from(
    [
      `Message-ID: ${messageId}`,
      "Date: Mon, 13 Jul 2026 12:00:00 +0000",
      `From: Cloud Conformance <${params.config.email}>`,
      `To: Cloud Conformance <${params.config.email}>`,
      "Subject: Cloud Mail connector conformance",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "connector conformance body",
      "",
    ].join("\r\n"),
  );

  let sourceCreated = false;
  let destinationCreated = false;
  let destinationRenamed = false;
  try {
    await params.connector.createFolder(params.config, sourcePath, true);
    sourceCreated = true;
    await params.connector.createFolder(params.config, destinationPath, true);
    destinationCreated = true;

    const discovered = await params.connector.discoverFolders(params.config);
    expect(discovered.some((folder) => folder.path === sourcePath && folder.selectable)).toBe(true);
    expect(discovered.some((folder) => folder.path === destinationPath && folder.selectable)).toBe(true);

    const appended = await params.connector.appendSource(
      params.config,
      sourcePath,
      Readable.from(source),
      source.byteLength,
      ["\\Seen", "CloudConformance"],
      new Date("2026-07-13T12:00:00.000Z"),
    );
    const sourceStatus = await params.connector.getFolderStatus(params.config, sourcePath);
    const sourceUid = appended.uid ?? (await findUid({ ...params, folderPath: sourcePath, messageId }));
    const sourceTarget: RemoteMutationTarget = {
      folderPath: sourcePath,
      uidValidity: appended.uidValidity ?? sourceStatus.uidValidity,
      uid: sourceUid,
    };

    const state = await params.connector.getMessageState(params.config, sourceTarget);
    expect(state).toMatchObject({ exists: true, messageId });
    expect(state.flags).toContain("\\Seen");
    expect(state.keywords.map((keyword) => keyword.toLowerCase())).toContain("cloudconformance");

    const changed = await params.connector.changeMessageState(params.config, sourceTarget, {
      addFlags: ["\\Flagged"],
      removeFlags: ["\\Seen"],
      addKeywords: ["CloudVerified"],
      removeKeywords: ["CloudConformance"],
    });
    expect(changed.exists).toBe(true);
    expect(changed.flags).toContain("\\Flagged");
    expect(changed.flags).not.toContain("\\Seen");
    expect(changed.keywords.map((keyword) => keyword.toLowerCase())).toContain("cloudverified");

    const batch = await params.connector.fetchEnvelopeBatch(params.config, {
      folderPath: sourcePath,
      folderStableKey: sourcePath,
      uidValidity: sourceTarget.uidValidity,
      lowUid: sourceUid,
      highUid: sourceUid,
      limit: 1,
    });
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({ messageId, subject: "Cloud Mail connector conformance" });

    const downloaded: Buffer[] = [];
    await params.connector.downloadSourceBatch(
      params.config,
      sourcePath,
      [{ key: "source", uidValidity: sourceTarget.uidValidity, uid: sourceUid }],
      async (item) => {
        expect(item.key).toBe("source");
        expect(item.expectedSize).toBe(source.byteLength);
        downloaded.push(await readStream(item.stream));
      },
    );
    expect(downloaded).toEqual([source]);

    const copied = await params.connector.copy(params.config, sourceTarget, destinationPath);
    const destinationStatus = await params.connector.getFolderStatus(params.config, destinationPath);
    const copiedUid = copied.destinationUid ?? (await findUid({ ...params, folderPath: destinationPath, messageId }));
    await params.connector.delete(params.config, {
      folderPath: destinationPath,
      uidValidity: copied.destinationUidValidity ?? destinationStatus.uidValidity,
      uid: copiedUid,
    });

    await params.connector.setFolderSubscription(params.config, destinationPath, false);
    await params.connector.setFolderSubscription(params.config, destinationPath, true);
    await params.connector.renameFolder(params.config, destinationPath, renamedPath);
    destinationRenamed = true;

    const sourceSet = { folderPath: sourcePath, uidValidity: sourceTarget.uidValidity, uids: [sourceUid] };
    const moved = await params.connector.moveMessages(params.config, sourceSet, renamedPath);
    expect(moved.completed).toBe(true);
    expect((await params.connector.getMessageStates(params.config, sourceSet)).size).toBe(0);
    const movedStatus = await params.connector.getFolderStatus(params.config, renamedPath);
    const movedUid = await findUid({ ...params, folderPath: renamedPath, messageId });
    await params.connector.delete(params.config, {
      folderPath: renamedPath,
      uidValidity: movedStatus.uidValidity,
      uid: movedUid,
    });

    const finalFolders = await params.connector.discoverFolders(params.config);
    expect(finalFolders.some((folder) => folder.path === destinationPath)).toBe(false);
    expect(finalFolders.some((folder) => folder.path === renamedPath && folder.subscribed)).toBe(true);
  } finally {
    if (sourceCreated) await params.connector.deleteFolder(params.config, sourcePath).catch(() => undefined);
    if (destinationCreated) {
      await params.connector.deleteFolder(params.config, destinationRenamed ? renamedPath : destinationPath).catch(() => undefined);
    }
  }
};

suite("generic IMAP connector conformance", () => {
  let config: ProviderConnectionInput;

  beforeAll(async () => {
    config = providerConnectionInputSchema.parse(await Bun.file(configPath!).json());
  });

  test(
    "round-trips folders, MIME source, flags, keywords, copy, move, and deletion",
    () => exerciseImapContract({ connector: imapSmtpConnector, config }),
    120_000,
  );
});
