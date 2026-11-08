import { DirectSession } from "@k2b/filegate/utils";
import { createPacedUploadRequest } from "./upload-pacing";

Object.assign(window, { createPacedUploadRequest, DirectSession });
