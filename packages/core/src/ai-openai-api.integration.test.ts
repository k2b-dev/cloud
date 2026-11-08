import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAiOpenAiRoutes, createCoreApiRouter } from "@k2b/cloud/api";
import { accounts, serviceAccountCredentials, session } from "@k2b/cloud/services";
import { coreSettings } from "@k2b/cloud/services/settings/api";
import { Hono } from "hono";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";

databaseSuite()("Core OpenAI API mount order", () => {});
