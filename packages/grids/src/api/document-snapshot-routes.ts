import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getDateConfig, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { gridsService } from "../service";
import { ALL_RECORD_ACCESS } from "../service/record-access";
import {
  PublicCreateRecordSnapshotResponseSchema,
  PublicRecordSnapshotListResponseSchema,
  PublicRecordSnapshotSchema,
  projectRecordSnapshot,
  projectRecordSnapshotSummaries,
  snapshotRecordAccessResolver,
} from "./documents-api-shared";
import { apiMessages } from "./messages";
import { currentActorUserId, currentActorViewer, gateAt } from "./permissions";
import { resolvePublicIdParam } from "./route-params";

export const createDocumentSnapshotRoutes = () =>
  new Hono<AuthContext>()
    .get(
      "/snapshots/by-record/:tableId/:recordId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List standalone record snapshots for a record",
        responses: {
          200: jsonResponse(PublicRecordSnapshotListResponseSchema, "Record snapshots"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        const recordId = await resolvePublicIdParam(c, "recordId", "record");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        if (!(await gridsService.record.get(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS }))) {
          return c.json({ message: apiMessages(c).recordNotFound }, 404);
        }
        const snapshots = await gridsService.document.listSnapshotsForRecord(tableId, recordId);
        return c.json({ items: await projectRecordSnapshotSummaries(snapshots) });
      },
    )

    .post(
      "/snapshots/by-record/:tableId/:recordId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Create a standalone recursive record snapshot",
        responses: {
          200: jsonResponse(PublicCreateRecordSnapshotResponseSchema, "Record snapshot"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        const recordId = await resolvePublicIdParam(c, "recordId", "record");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const snapshot = await gridsService.document.createRecordSnapshot({
          baseId: table.baseId,
          tableId,
          recordId,
          actorId: currentActorUserId(c),
          resolveRecordAccess: snapshotRecordAccessResolver(c),
          viewer: currentActorViewer(c),
          dateConfig: await getDateConfig(c),
        });
        if (!snapshot.ok) return c.json({ message: snapshot.error.message }, snapshot.error.status);
        return c.json({ snapshot: await projectRecordSnapshot(snapshot.data) });
      },
    )

    .get(
      "/snapshots/:snapshotId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Get a record snapshot",
        responses: {
          200: jsonResponse(PublicRecordSnapshotSchema, "Record snapshot"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const snapshotId = await resolvePublicIdParam(c, "snapshotId", "documentSnapshot");
        if (!snapshotId) return c.json({ message: apiMessages(c).recordSnapshotNotFound }, 404);
        const snapshot = await gridsService.document.getSnapshot(snapshotId);
        if (!snapshot) return c.json({ message: apiMessages(c).recordSnapshotNotFound }, 404);
        const gate = await gateAt(c, { baseId: snapshot.baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        if (
          !(await gridsService.record.get(snapshot.tableId, snapshot.recordId, {
            recordAccess: ALL_RECORD_ACCESS,
            deleted: "include",
          }))
        ) {
          return c.json({ message: apiMessages(c).recordSnapshotNotFound }, 404);
        }
        return c.json(
          await projectRecordSnapshot(await gridsService.document.filterSnapshotRelatedRecords(snapshot, snapshotRecordAccessResolver(c))),
        );
      },
    );
