export const aiMissingChatFileError = (path: string, localToolsEnabled?: boolean, message = `No such file: ${path}`): Error =>
  new Error(`${message}${localToolsEnabled ? " This is a chat path. Upload local files with local_upload first." : ""}`);
