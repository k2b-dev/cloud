// Observe the real controller without replacing authorization, storage, transport or editor behavior.
import { type NotebookDeviceState, type NotebookDocumentClient, openNotebookDocument as open } from "./offline";

export { NotebookAuthorizationError, type NotebookDeviceState, type NotebookDocumentClient } from "./offline";

export const notebookDevice: {
  client?: NotebookDocumentClient;
  state: NotebookDeviceState;
  connected: boolean;
} = { state: { pending: false, saved: false, failed: false, recovery: false }, connected: false };

export const openNotebookDocument: typeof open = async (options) => {
  const client = await open({
    ...options,
    onDeviceState: (state) => {
      notebookDevice.state = state;
      options.onDeviceState(state);
    },
    onConnectionChange: (connected) => {
      notebookDevice.connected = connected;
      options.onConnectionChange?.(connected);
    },
  });
  notebookDevice.client = client;
  return client;
};
