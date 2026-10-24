import { spyOn } from "bun:test";
import { DownstreamBusyError, downstreamBudget } from "../../packages/cloud/src/services/downstream-budget";

/** Isolate PDF consumer unit tests from the platform-owned shared budget. */
export const mockPdfAdmission = () => spyOn(downstreamBudget, "acquire").mockResolvedValue(() => {});
export const pdfAdmissionBusy = () => new DownstreamBusyError("gotenberg");
