import { defineHelp } from "@k2b/cloud/server";
import buildBaseDe from "./documents/de/grids-build-base.help.md" with { type: "text" };
import buildBusinessAppDe from "./documents/de/grids-build-business-app.help.md" with { type: "text" };
import buildCustomAppDe from "./documents/de/grids-build-custom-app.help.md" with { type: "text" };
import combinedTablesDe from "./documents/de/grids-combined-tables.help.md" with { type: "text" };
import coreModelDe from "./documents/de/grids-core-model.help.md" with { type: "text" };
import customAppPagesBlocksDe from "./documents/de/grids-custom-app-pages-blocks.help.md" with { type: "text" };
import customAppYamlCliDe from "./documents/de/grids-custom-app-yaml-cli.help.md" with { type: "text" };
import customAppsDe from "./documents/de/grids-custom-apps.help.md" with { type: "text" };
import documentsDe from "./documents/de/grids-documents-pdfs.help.md" with { type: "text" };
import evidenceExportsDe from "./documents/de/grids-evidence-exports.help.md" with { type: "text" };
import formsDe from "./documents/de/grids-forms.help.md" with { type: "text" };
import formulasDe from "./documents/de/grids-formulas.help.md" with { type: "text" };
import gqlDe from "./documents/de/grids-gql.help.md" with { type: "text" };
import operationsDe from "./documents/de/grids-operations-troubleshooting.help.md" with { type: "text" };
import overviewDe from "./documents/de/grids-overview.help.md" with { type: "text" };
import permissionsDe from "./documents/de/grids-permissions.help.md" with { type: "text" };
import publishCustomAppDe from "./documents/de/grids-publish-custom-app.help.md" with { type: "text" };
import retentionPreservationDe from "./documents/de/grids-retention-preservation.help.md" with { type: "text" };
import tablesFieldsDe from "./documents/de/grids-tables-fields.help.md" with { type: "text" };
import viewsReportsDe from "./documents/de/grids-views-reports.help.md" with { type: "text" };
import workflowsDe from "./documents/de/grids-workflows.help.md" with { type: "text" };
import buildBase from "./documents/en/grids-build-base.help.md" with { type: "text" };
import buildBusinessApp from "./documents/en/grids-build-business-app.help.md" with { type: "text" };
import buildCustomApp from "./documents/en/grids-build-custom-app.help.md" with { type: "text" };
import combinedTables from "./documents/en/grids-combined-tables.help.md" with { type: "text" };
import coreModel from "./documents/en/grids-core-model.help.md" with { type: "text" };
import customAppPagesBlocks from "./documents/en/grids-custom-app-pages-blocks.help.md" with { type: "text" };
import customAppYamlCli from "./documents/en/grids-custom-app-yaml-cli.help.md" with { type: "text" };
import customApps from "./documents/en/grids-custom-apps.help.md" with { type: "text" };
import documents from "./documents/en/grids-documents-pdfs.help.md" with { type: "text" };
import evidenceExports from "./documents/en/grids-evidence-exports.help.md" with { type: "text" };
import forms from "./documents/en/grids-forms.help.md" with { type: "text" };
import formulas from "./documents/en/grids-formulas.help.md" with { type: "text" };
import gql from "./documents/en/grids-gql.help.md" with { type: "text" };
import operations from "./documents/en/grids-operations-troubleshooting.help.md" with { type: "text" };
import overview from "./documents/en/grids-overview.help.md" with { type: "text" };
import permissions from "./documents/en/grids-permissions.help.md" with { type: "text" };
import publishCustomApp from "./documents/en/grids-publish-custom-app.help.md" with { type: "text" };
import retentionPreservation from "./documents/en/grids-retention-preservation.help.md" with { type: "text" };
import tablesFields from "./documents/en/grids-tables-fields.help.md" with { type: "text" };
import viewsReports from "./documents/en/grids-views-reports.help.md" with { type: "text" };
import workflows from "./documents/en/grids-workflows.help.md" with { type: "text" };

export const gridsHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [
      overview,
      coreModel,
      buildBase,
      buildBusinessApp,
      tablesFields,
      viewsReports,
      combinedTables,
      gql,
      formulas,
      forms,
      buildCustomApp,
      customAppPagesBlocks,
      publishCustomApp,
      customAppYamlCli,
      customApps,
      documents,
      workflows,
      permissions,
      evidenceExports,
      retentionPreservation,
      operations,
    ],
    de: [
      overviewDe,
      coreModelDe,
      buildBaseDe,
      buildBusinessAppDe,
      tablesFieldsDe,
      viewsReportsDe,
      combinedTablesDe,
      gqlDe,
      formulasDe,
      formsDe,
      buildCustomAppDe,
      customAppPagesBlocksDe,
      publishCustomAppDe,
      customAppYamlCliDe,
      customAppsDe,
      documentsDe,
      workflowsDe,
      permissionsDe,
      evidenceExportsDe,
      retentionPreservationDe,
      operationsDe,
    ],
  },
});
