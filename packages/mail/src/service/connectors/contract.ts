import type { Readable } from "node:stream";
import type {
  ConnectorVerification,
  MailEndpoint,
  ProviderConnectionInput,
  ProviderLimitSnapshot,
  ProviderSecret,
  RemoteFolder,
  RemoteMessageRef,
  SmtpTransportCapabilities,
} from "../../contracts";
import type { MessageProtocolFacts } from "../message-protocol";

export type ConnectorAddress = {
  name: string | null;
  address: string;
};

export type ConnectorProtocolFacts = MessageProtocolFacts;

export type ConnectorEnvelope = {
  remoteRef: RemoteMessageRef;
  providerMessageId: string | null;
  providerThreadId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  protocolFacts?: ConnectorProtocolFacts;
  subject: string;
  sentAt: Date | null;
  internalDate: Date;
  sizeBytes: number;
  flags: string[];
  labels: string[];
  addresses: {
    from: ConnectorAddress[];
    replyTo: ConnectorAddress[];
    to: ConnectorAddress[];
    cc: ConnectorAddress[];
    bcc: ConnectorAddress[];
  };
  mimeStructure: Record<string, unknown>;
};

export type EnvelopeBatchRequest = {
  folderPath: string;
  folderStableKey: string;
  uidValidity: string;
  highUid: number;
  lowUid?: number;
  limit: number;
  /** Fetch exactly these UIDs instead of selecting a window; used to re-import gaps found while reconciling. */
  uids?: number[];
};

export type EnvelopeBatch = {
  messages: ConnectorEnvelope[];
  nextHighUid: number | null;
};

export type SourceDownloadRequest = {
  key: string;
  uidValidity: string;
  uid: number;
};

export type SourceDownload = SourceDownloadRequest & {
  expectedSize: number;
  stream: Readable;
};

export type FolderStatusSnapshot = {
  uidValidity: string;
  uidNext: number;
  highestModseq: string | null;
  messages: number;
};

export type FlagChange = {
  uid: number;
  modseq: string | null;
  flags: string[];
  labels: string[];
};

export type SendRequest = {
  from: { name?: string | null; address: string };
  replyTo?: string | null;
  envelopeFrom?: string | null;
  to: Array<{ name?: string | null; address: string }>;
  cc?: Array<{ name?: string | null; address: string }>;
  bcc?: Array<{ name?: string | null; address: string }>;
  subject: string;
  text: string;
  html?: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
};

export type SendResult = {
  accepted: string[];
  rejected: string[];
  response: string;
  messageId: string;
};

export type RemoteMutationTarget = {
  folderPath: string;
  uidValidity: string;
  uid: number;
};

export type RemoteCopyResult = {
  destinationUidValidity: string | null;
  destinationUid: number | null;
};

export type RemoteAppendResult = {
  uidValidity: string | null;
  uid: number | null;
};

export type ConnectorChangeHint =
  | {
      type: "folder_changed";
      cause: "exists" | "flags" | "vanished" | "uidvalidity_changed";
      folderPath: string;
      uid: number | null;
      modseq: string | null;
    }
  | {
      type: "overflow";
      folderPath: string;
    }
  | {
      type: "disconnected";
      folderPath: string;
      reason: "closed" | "error";
    };

export type ConnectorChangeListenerMode = "qresync" | "idle" | "poll";

export type ConnectorChangeListenerRequest = {
  folderPath: string;
  uidValidity: string;
  highestModseq: string | null;
  maxPendingHints: number;
};

export type ConnectorChangeListener = {
  mode: ConnectorChangeListenerMode;
  hints: AsyncIterable<ConnectorChangeHint>;
  close(): Promise<void>;
};

export type RemoteMessageState = {
  exists: boolean;
  flags: string[];
  keywords: string[];
  messageId: string | null;
  modseq: string | null;
};

export type RemoteMessageStateChange = {
  addFlags: string[];
  removeFlags: string[];
  addKeywords: string[];
  removeKeywords: string[];
};

export type SendSourceRequest = {
  source: Readable;
  envelopeFrom: string | null;
  recipients: string[];
  messageId: string;
  deliveryStatusNotification?: {
    id: string;
  };
  signal?: AbortSignal;
};

export type SmtpConnectionConfig = {
  username: string;
  smtp: MailEndpoint;
  secret: ProviderSecret;
};

export interface MailConnector {
  verify(config: ProviderConnectionInput): Promise<ConnectorVerification>;
  verifySmtp(config: SmtpConnectionConfig): Promise<SmtpTransportCapabilities>;
  discoverLimits(config: ProviderConnectionInput): Promise<ProviderLimitSnapshot>;
  discoverFolders(config: ProviderConnectionInput, signal?: AbortSignal): Promise<RemoteFolder[]>;
  getFolderStatus(config: ProviderConnectionInput, folderPath: string, signal?: AbortSignal): Promise<FolderStatusSnapshot>;
  fetchEnvelopeBatch(config: ProviderConnectionInput, request: EnvelopeBatchRequest, signal?: AbortSignal): Promise<EnvelopeBatch>;
  fetchFlagChanges(
    config: ProviderConnectionInput,
    folderPath: string,
    uidValidity: string,
    sinceModseq: string,
    lowUid: number,
    highUid: number,
    signal?: AbortSignal,
  ): Promise<FlagChange[]>;
  fetchUidWindow(
    config: ProviderConnectionInput,
    folderPath: string,
    uidValidity: string,
    lowUid: number,
    highUid: number,
    signal?: AbortSignal,
  ): Promise<FlagChange[]>;
  downloadSourceBatch(
    config: ProviderConnectionInput,
    folderPath: string,
    requests: SourceDownloadRequest[],
    consume: (source: SourceDownload) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  send(config: ProviderConnectionInput, request: SendRequest): Promise<SendResult>;
  sendSource(config: SmtpConnectionConfig, request: SendSourceRequest): Promise<SendResult>;
  setFlags(config: ProviderConnectionInput, target: RemoteMutationTarget, flags: string[]): Promise<void>;
  changeMessageState(
    config: ProviderConnectionInput,
    target: RemoteMutationTarget,
    change: RemoteMessageStateChange,
  ): Promise<RemoteMessageState>;
  copy(config: ProviderConnectionInput, target: RemoteMutationTarget, destinationPath: string): Promise<RemoteCopyResult>;
  move(config: ProviderConnectionInput, target: RemoteMutationTarget, destinationPath: string): Promise<RemoteCopyResult>;
  delete(config: ProviderConnectionInput, target: RemoteMutationTarget): Promise<void>;
  appendSource(
    config: ProviderConnectionInput,
    folderPath: string,
    source: Readable,
    byteLength: number,
    flags?: string[],
    internalDate?: Date,
    signal?: AbortSignal,
  ): Promise<RemoteAppendResult>;
  findMessageById(config: ProviderConnectionInput, folderPath: string, messageId: string, signal?: AbortSignal): Promise<number[]>;
  getMessageState(config: ProviderConnectionInput, target: RemoteMutationTarget): Promise<RemoteMessageState>;
  createFolder(config: ProviderConnectionInput, path: string, subscribe: boolean): Promise<void>;
  renameFolder(config: ProviderConnectionInput, path: string, newPath: string): Promise<void>;
  deleteFolder(config: ProviderConnectionInput, path: string): Promise<void>;
  setFolderSubscription(config: ProviderConnectionInput, path: string, subscribed: boolean): Promise<void>;
  listenForChanges?(config: ProviderConnectionInput, request: ConnectorChangeListenerRequest): Promise<ConnectorChangeListener>;
}
