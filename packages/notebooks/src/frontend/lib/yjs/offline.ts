import {
  openSharedTextDocument,
  type SharedTextDeviceState,
  SharedTextDocumentAuthorizationError,
  type SharedTextProviderError,
} from "@k2b/cloud/browser/shared-text";
import { apiClient } from "../../../api/client";
import { noteDocumentSessionSchema, noteGenerationSchema } from "../../../lib/document-session";
import { notebooksYjs } from "../../../lib/yjs";
import { createYjsProvider, type YjsProviderOptions } from "./provider";

export class NotebookAuthorizationError extends SharedTextDocumentAuthorizationError {
  constructor(status: number) {
    super(status, `Notebook authorization failed (${status})`);
  }
}
export type NotebookDeviceState = SharedTextDeviceState;
export type NotebookDocumentClient = Awaited<ReturnType<typeof openNotebookDocument>>;

/** Application authorization and wire adapter; journal and receipts belong to the platform. */
export const openNotebookDocument = (
  options: Omit<YjsProviderOptions, "initialPending" | "initialCursor" | "initialRestoreRevision"> & {
    recoveryOnly?: boolean;
    memoryOnly?: boolean;
    notebookId: string;
    userId: string;
    signal: AbortSignal;
    onDeviceState(state: NotebookDeviceState): void;
  },
) => {
  const fromError = (error: SharedTextProviderError) => ({
    ...error,
    code: Object.values(notebooksYjs.errorCode).find((code) => code === error.code) ?? notebooksYjs.errorCode.internalError,
    noteId: error.docId,
  });
  return openSharedTextDocument({
    ...options,
    docId: options.noteId,
    draftId: `notebooks:${options.noteId}`,
    parseGeneration: (value) => noteGenerationSchema.parse(value),
    compareGeneration: (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
    authorize: async (generation, signal) => {
      const response = await apiClient[":id"].notes[":noteId"].document
        .$get(
          {
            param: { id: options.notebookId, noteId: options.noteId },
            query: { expectedUserId: options.userId, generation },
          },
          { init: { cache: "no-store", signal } },
        )
        .catch((error: unknown) => {
          if (error instanceof TypeError) throw new NotebookAuthorizationError(0);
          throw error;
        });
      if (!response.ok) throw new NotebookAuthorizationError(response.status);
      return noteDocumentSessionSchema.parse(await response.json());
    },
    createProvider: ({ initialGeneration, onFatal, ...input }) =>
      createYjsProvider({
        ...options,
        ...input,
        expectedUserId: options.userId,
        initialRestoreRevision: initialGeneration,
        onLocalUpdate: (pending) => {
          input.onLocalUpdate(pending);
          options.onLocalUpdate?.(pending);
        },
        onSnapshot: (snapshot) => {
          input.onSnapshot(snapshot);
          options.onSnapshot?.(snapshot);
        },
        onReady: () => {
          input.onReady();
          options.onReady?.();
        },
        onUnsentChange: () => {
          options.onUnsentChange?.();
          input.onUnsentChange();
        },
        onFatal: (error) => onFatal({ ...error, docId: error.noteId }),
      }),
    onFatal: (error) => options.onFatal?.(fromError(error)),
    messages: {
      signedOut: "Device storage signed out",
      generationChanged: "Document generation changed",
      locked: "Note locked",
      activeInput: "Notebook input is still active",
    },
    missingCode: "NOTE_NOT_FOUND",
    lockedCode: "NOTE_LOCKED",
  });
};
