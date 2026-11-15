import type { LiveViewer } from "@k2b/cloud/events";
import { z } from "zod";
import { codeLiveReaders } from "./access";
import { CodeIdSchema } from "./contracts";
import { findCode } from "./store";

/** Served beside `user` on Core's socket. SQL is confined to admission, access changes and reauthorize sweeps. */
export const codeLiveChannels = {
  code: {
    eventOnly: true as const,
    reauthorize: true as const,
    scope: z.object({ codeId: CodeIdSchema }).strict(),
    keys: async ({ codeId }: { codeId: string }) => [codeId],
    authorize: async (key: string, viewers: readonly LiveViewer[]) => {
      const code = await findCode(key);
      return code ? codeLiveReaders(code, viewers) : new Set<string>();
    },
  },
};
