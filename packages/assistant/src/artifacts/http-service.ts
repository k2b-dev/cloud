export * from "../chat-code/http-service";

import { createHttpService } from "../chat-code/http-service";
import { resolveRuntimeResource } from "./runtime-resource";
export const httpService = createHttpService(resolveRuntimeResource);
