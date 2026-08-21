import { arg, type CloudCliContext, command, flag } from "@valentinkolb/cloud/cli";
import type { BusinessDocument, BusinessDocumentIssue, BusinessDocumentProfileSummary } from "../business-document-contracts";
import { baseArgs, baseFlag, requirePublicId, resolveBaseFromCommand } from "./resources";
import {
  JSON_BODY_INPUT,
  jsonRequest,
  printJsonOrTable,
  queryString,
  readApi,
  readJsonInput,
  requireRestArg,
  writeApiFile,
} from "./runtime";

type IssueResponse = { document: BusinessDocument; replayed: boolean };
type ListResponse = { items: BusinessDocument[]; cursor: string | null; hasMore: boolean };

const rows = (items: BusinessDocument[]) =>
  items.map((item) => ({
    id: item.id,
    number: item.number,
    profile: `${item.profileId}@${item.profileVersion}`,
    relationship: item.relationship,
    predecessor: item.predecessorId ?? "",
    issuedAt: item.issuedAt,
  }));

const printDocuments = (ctx: CloudCliContext, value: unknown, items: BusinessDocument[]) =>
  printJsonOrTable(ctx, value, rows(items), [
    { key: "id", label: "ID" },
    { key: "number", label: "NUMBER" },
    { key: "profile", label: "PROFILE" },
    { key: "relationship", label: "RELATIONSHIP" },
    { key: "predecessor", label: "PREDECESSOR" },
    { key: "issuedAt", label: "ISSUED" },
  ]);

export const businessDocumentCommands = [
  command("business-documents profiles", {
    summary: "List installed immutable Business Document profiles",
    async run({ ctx }) {
      const profiles = await readApi<BusinessDocumentProfileSummary[]>(ctx, "/business-documents/profiles");
      printJsonOrTable(
        ctx,
        profiles,
        profiles.map((profile) => ({ ...profile, profile: `${profile.id}@${profile.version}` })),
        [
          { key: "profile", label: "PROFILE" },
          { key: "title", label: "TITLE" },
          { key: "rendererVersion", label: "RENDERER" },
          { key: "validatorVersion", label: "VALIDATOR" },
        ],
      );
    },
  }),
  command("business-documents list", {
    summary: "List immutable Business Documents in a Base",
    args: baseArgs,
    flags: {
      ...baseFlag,
      profile: flag.string({ description: "Profile id" }),
      limit: flag.int({ min: 1, max: 100, description: "Maximum documents" }),
      cursor: flag.string({ description: "Pagination cursor" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const result = await readApi<ListResponse>(
        ctx,
        `/business-documents/by-base/${encodeURIComponent(base.id)}${queryString({ profileId: flags.profile, limit: flags.limit, cursor: flags.cursor })}`,
      );
      printDocuments(ctx, result, result.items);
    },
  }),
  command("business-documents issue", {
    summary: "Issue from an exact native JSON snapshot",
    description:
      "The body contains profileId, profileVersion, idempotencyKey, source, sourceRevision, snapshot, and optional correction metadata.",
    args: baseArgs,
    flags: { ...baseFlag, body: JSON_BODY_INPUT },
    examples: ["cld grids business-documents issue Bookshop --body-file statement.json --json"],
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const body = await readJsonInput<BusinessDocumentIssue>(flags.body, "Business Document issue JSON", true);
      const result = await readApi<IssueResponse>(
        ctx,
        `/business-documents/by-base/${encodeURIComponent(base.id)}/issue`,
        jsonRequest("POST", body),
      );
      printDocuments(ctx, result, [result.document]);
    },
  }),
  command("business-documents issue-from-gql", {
    summary: "Issue from one bounded permission-safe GQL result",
    description:
      "The JSON body contains the profile, idempotency and relationship fields plus query and optional currentTableId/currentSource.",
    args: baseArgs,
    flags: { ...baseFlag, body: JSON_BODY_INPUT },
    examples: ["cld grids business-documents issue-from-gql Bookshop --body-file issuance.json --json"],
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const body = await readJsonInput<Record<string, unknown>>(flags.body, "Business Document GQL issue JSON", true);
      const result = await readApi<IssueResponse>(
        ctx,
        `/business-documents/by-base/${encodeURIComponent(base.id)}/issue-from-gql`,
        jsonRequest("POST", body),
      );
      printDocuments(ctx, result, [result.document]);
    },
  }),
  command("business-documents get", {
    summary: "Inspect an immutable Business Document",
    args: { args: arg.rest({ valueLabel: "document-id", description: "Business Document public id" }) },
    async run({ ctx, args }) {
      const id = requirePublicId(requireRestArg(args.args, 0, "Business Document id"), "Business Document id");
      const document = await readApi<BusinessDocument>(ctx, `/business-documents/${encodeURIComponent(id)}`);
      printDocuments(ctx, document, [document]);
    },
  }),
  command("business-documents download", {
    summary: "Download one exact immutable artifact",
    args: { args: arg.rest({ valueLabel: "document-id artifact-key", description: "Public document id and artifact key" }) },
    flags: { out: flag.string({ aliases: ["o"], description: "Output file" }) },
    async run({ ctx, args, flags }) {
      const id = requirePublicId(requireRestArg(args.args, 0, "Business Document id"), "Business Document id");
      const key = requireRestArg(args.args, 1, "artifact key");
      await writeApiFile(ctx, `/business-documents/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(key)}`, undefined, flags.out);
    },
  }),
];
