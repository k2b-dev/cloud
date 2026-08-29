import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  dialogCore,
  InlineGuidance,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicDurableHistoryStatus } from "../../../api/durable-history";
import type { PublicRecordFinalizationStatus } from "../../../api/record-finalization";
import type { PrincipalReference } from "../../../field-types/principal";
import PrincipalInput from "../forms/PrincipalInput";
import { errorMessage } from "../utils/api-helpers";
import { gridsDialogMessages } from "./messages";

export const openHistoryProtectionDialog = (args: { tableId: string; tableName: string }) =>
  dialogCore.open<void>((close) => {
    const locale = useLocale();
    const t = () => gridsDialogMessages.resolve([locale()]).t;
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().historyProtection} subtitle={args.tableName} icon="ti ti-history" close={close} />
        <HistoryProtectionBody tableId={args.tableId} />
      </PanelDialog>
    );
  }, panelDialogOptions);

function HistoryProtectionBody(props: { tableId: string }) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const statusQuery = query.create({
    source: () => props.tableId,
    load: async (tableId, { abortSignal }) => {
      const [historyResponse, finalizationResponse] = await Promise.all([
        apiClient.tables[":tableId"]["durable-history"].$get({ param: { tableId } }, { init: { signal: abortSignal } }),
        apiClient.tables[":tableId"].finalization.$get({ param: { tableId } }, { init: { signal: abortSignal } }),
      ]);
      if (!historyResponse.ok) throw new Error(await errorMessage(historyResponse, t().historyLoadFailed));
      if (!finalizationResponse.ok) throw new Error(await errorMessage(finalizationResponse, t().finalizationLoadFailed));
      return {
        history: await historyResponse.json(),
        finalization: await finalizationResponse.json(),
      } satisfies { history: PublicDurableHistoryStatus; finalization: PublicRecordFinalizationStatus };
    },
  });
  const historyStatus = () => statusQuery.data()?.history ?? null;
  const enabledHistoryStatus = () => {
    const status = historyStatus();
    return status?.enabled ? status : null;
  };
  const finalizationStatus = () => statusQuery.data()?.finalization ?? null;
  const enabledFinalizationStatus = () => {
    const status = finalizationStatus();
    return status?.enabled ? status : null;
  };
  const [policyMode, setPolicyMode] = createSignal<"direct" | "fourEyes">("direct");
  const [approverGroup, setApproverGroup] = createSignal<PrincipalReference | null>(null);
  const refreshAfterChange = async (message: string) => {
    try {
      await statusQuery.refresh();
    } catch {
      prompts.error(message);
    }
  };
  let synchronizedPolicyRevision = 0;
  createEffect(() => {
    const status = enabledFinalizationStatus();
    if (!status) {
      synchronizedPolicyRevision = 0;
      setPolicyMode("direct");
      setApproverGroup(null);
      return;
    }
    if (status.policyRevision === synchronizedPolicyRevision) return;
    synchronizedPolicyRevision = status.policyRevision;
    setPolicyMode(status.mode);
    setApproverGroup(status.approverGroupId ? { type: "group", id: status.approverGroupId } : null);
  });

  const historyMut = mutations.create<PublicDurableHistoryStatus, "enable" | "continue">({
    mutation: async (operation) => {
      let response =
        operation === "enable"
          ? await apiClient.tables[":tableId"]["durable-history"].enable.$post({ param: { tableId: props.tableId } })
          : await apiClient.tables[":tableId"]["durable-history"].continue.$post({ param: { tableId: props.tableId } });
      if (!response.ok) throw new Error(await errorMessage(response, t().historyEnableFailed));
      let status = await response.json();
      while (status.enabled && status.status === "activating") {
        const captured = status.baseline.captured;
        response = await apiClient.tables[":tableId"]["durable-history"].continue.$post({ param: { tableId: props.tableId } });
        if (!response.ok) throw new Error(await errorMessage(response, t().historyContinueFailed));
        status = await response.json();
        if (status.enabled && status.status === "activating" && status.baseline.captured <= captured) {
          throw new Error(t().baselineWaiting);
        }
      }
      return status;
    },
    onSuccess: () => refreshAfterChange(t().historyRefreshFailed),
    onError: (error) => {
      void statusQuery.refresh();
      prompts.error(error.message);
    },
  });

  const enableHistory = async () => {
    const confirmed = await prompts.confirm(t().historyEnableConfirm, { title: t().historyEnableQuestion, confirmText: t().enableHistory });
    if (confirmed) historyMut.mutate("enable");
  };

  const finalizationMut = mutations.create<PublicRecordFinalizationStatus, "enable" | "disable">({
    mutation: async (operation) => {
      const response =
        operation === "enable"
          ? await apiClient.tables[":tableId"].finalization.enable.$post({
              param: { tableId: props.tableId },
              json: policyMode() === "fourEyes" ? { mode: "fourEyes", approverGroupId: approverGroup()!.id } : { mode: "direct" },
            })
          : await apiClient.tables[":tableId"].finalization.disable.$post({ param: { tableId: props.tableId } });
      if (!response.ok)
        throw new Error(
          await errorMessage(
            response,
            t().finalizationActionFailed({ action: operation === "enable" ? t().enableAction : t().disableAction }),
          ),
        );
      return response.json();
    },
    onSuccess: () => refreshAfterChange(t().finalizationRefreshFailed),
    onError: (error) => prompts.error(error.message),
  });

  const changeFinalization = async (operation: "enable" | "disable") => {
    if (operation === "enable" && policyMode() === "fourEyes" && !approverGroup()) {
      prompts.error(t().chooseApproverFirst);
      return;
    }
    const confirmed = await prompts.confirm(operation === "enable" ? t().enableFinalizationConfirm : t().disableFinalizationConfirm, {
      title: operation === "enable" ? t().enableFinalizationQuestion : t().disableFinalizationQuestion,
      confirmText: operation === "enable" ? t().enableFinalization : t().disableFinalization,
      ...(operation === "disable" ? { variant: "danger" as const } : {}),
    });
    if (confirmed) finalizationMut.mutate(operation);
  };

  const policyMut = mutations.create<PublicRecordFinalizationStatus, { mode: "direct" } | { mode: "fourEyes"; approverGroupId: string }>({
    mutation: async (policy) => {
      const response = await apiClient.tables[":tableId"].finalization.policy.$put({
        param: { tableId: props.tableId },
        json: policy,
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().policyUpdateFailed));
      return response.json();
    },
    onSuccess: () => refreshAfterChange(t().policyRefreshFailed),
    onError: (error) => {
      void statusQuery.refresh();
      prompts.error(error.message);
    },
  });

  const policyChanged = () => {
    const current = enabledFinalizationStatus();
    if (!current) return false;
    return (
      current.mode !== policyMode() || current.approverGroupId !== (policyMode() === "fourEyes" ? (approverGroup()?.id ?? null) : null)
    );
  };

  const savePolicy = async () => {
    const group = approverGroup();
    if (policyMode() === "fourEyes" && (!group || group.type !== "group")) {
      prompts.error(t().chooseApproverGroup);
      return;
    }
    const current = enabledFinalizationStatus();
    const weakening = current?.mode === "fourEyes" && policyMode() === "direct";
    const confirmed = await prompts.confirm(policyMode() === "fourEyes" ? t().fourEyesConfirm : t().directConfirm, {
      title: policyMode() === "fourEyes" ? t().requireFourEyesQuestion : t().allowDirectQuestion,
      confirmText: t().changeFinalizationMode,
      ...(weakening ? { variant: "danger" as const } : {}),
    });
    if (!confirmed) return;
    policyMut.mutate(policyMode() === "fourEyes" ? { mode: "fourEyes", approverGroupId: group!.id } : { mode: "direct" });
  };

  return (
    <PanelDialog.Body>
      <NoticeCard tone="info" title={t().historyIntro} detail={t().historyIntroDetail} />
      <Show when={!statusQuery.loading()} fallback={<Placeholder state="loading" align="left" title={t().loadingHistory} />}>
        <Show
          when={!statusQuery.error()}
          fallback={
            <Placeholder
              state="error"
              align="left"
              title={t().historyUnavailable}
              description={statusQuery.error()?.message}
              action={
                <Button variant="secondary" size="sm" type="button" onClick={() => void statusQuery.refresh()}>
                  {t().retry}
                </Button>
              }
            />
          }
        >
          <Show when={statusQuery.data()}>
            <PanelDialog.Section title={t().durableHistory} subtitle={t().durableHistoryDetail} icon="ti ti-history">
              <Show
                when={enabledHistoryStatus()}
                fallback={
                  <div class="flex flex-col items-start gap-3">
                    <InlineGuidance>{t().historyStartsNow}</InlineGuidance>
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      onClick={() => void enableHistory()}
                      loading={historyMut.loading()}
                      loadingLabel={t().enablingHistory}
                    >
                      <i class="ti ti-history" aria-hidden="true" /> {t().enableHistory}
                    </Button>
                  </div>
                }
              >
                {(status) => (
                  <div class="flex flex-col items-start gap-3">
                    <NoticeCard
                      class="w-full"
                      tone={status().status === "active" ? "success" : "warning"}
                      title={status().status === "active" ? t().historyOn : t().preparingHistory}
                      detail={
                        status().status === "active"
                          ? t().historyActiveSince({ date: new Date(status().activatedAt).toLocaleString(locale()) })
                          : t().historyProgress({ captured: status().baseline.captured, total: status().baseline.total })
                      }
                    />
                    <Show when={status().status === "activating"}>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => historyMut.mutate("continue")}
                        loading={historyMut.loading()}
                        loadingLabel={t().savingExisting}
                      >
                        {t().continueSetup}
                      </Button>
                    </Show>
                  </div>
                )}
              </Show>
            </PanelDialog.Section>

            <PanelDialog.Section title={t().recordFinalization} subtitle={t().recordFinalizationDetail} icon="ti ti-lock">
              <Show when={finalizationStatus()}>
                {(status) => (
                  <Show
                    when={enabledFinalizationStatus()}
                    fallback={
                      <div class="flex flex-col items-start gap-3">
                        <InlineGuidance tone={status().durableHistory === "active" ? "neutral" : "warning"}>
                          {status().durableHistory === "active" ? t().finalizationOff : t().enableHistoryFirst}
                        </InlineGuidance>
                        <div class="flex w-full flex-col gap-3">
                          <Select
                            label={t().finalizationMode}
                            description={t().finalizationModeDetail}
                            options={[
                              {
                                id: "direct",
                                label: t().direct,
                                description: t().directDetail,
                                icon: "ti ti-lock",
                              },
                              {
                                id: "fourEyes",
                                label: t().fourEyes,
                                description: t().fourEyesDetail,
                                icon: "ti ti-users-group",
                              },
                            ]}
                            value={policyMode}
                            onValueChange={(value) => {
                              if (value === "direct" || value === "fourEyes") setPolicyMode(value);
                            }}
                            disabled={status().durableHistory !== "active" || finalizationMut.loading()}
                          />
                          <Show when={policyMode() === "fourEyes"}>
                            <PrincipalInput
                              label={t().approverGroup}
                              description={t().approverGroupDetail}
                              value={approverGroup() ? [approverGroup()!] : null}
                              multi={false}
                              types={["group"]}
                              disabled={status().durableHistory !== "active" || finalizationMut.loading()}
                              onChange={(value) => setApproverGroup(value?.[0] ?? null)}
                            />
                          </Show>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          disabled={status().durableHistory !== "active" || (policyMode() === "fourEyes" && !approverGroup())}
                          onClick={() => void changeFinalization("enable")}
                          loading={finalizationMut.loading()}
                          loadingLabel={t().enablingFinalization}
                        >
                          <i class="ti ti-lock" /> {t().enableFinalization}
                        </Button>
                      </div>
                    }
                  >
                    {(enabled) => (
                      <div class="flex flex-col items-start gap-3">
                        <NoticeCard
                          class="w-full"
                          tone="success"
                          title={t().finalizationOn}
                          detail={
                            enabled().finalizedCount === 0
                              ? enabled().mode === "fourEyes"
                                ? t().fourEyesStatus({ group: enabled().approverGroupName ?? t().defaultApproverGroup })
                                : t().directDetail
                              : t().finalizedCount({ count: enabled().finalizedCount })
                          }
                        />
                        <div class="flex w-full flex-col gap-3">
                          <div class="flex flex-col gap-3">
                            <Select
                              label={t().finalizationMode}
                              description={t().finalizationModeDetail}
                              options={[
                                {
                                  id: "direct",
                                  label: t().direct,
                                  description: t().directDetail,
                                  icon: "ti ti-lock",
                                },
                                {
                                  id: "fourEyes",
                                  label: t().fourEyes,
                                  description: t().fourEyesDetail,
                                  icon: "ti ti-users-group",
                                },
                              ]}
                              value={policyMode}
                              onValueChange={(value) => {
                                if (value === "direct" || value === "fourEyes") setPolicyMode(value);
                              }}
                              disabled={policyMut.loading()}
                            />
                            <Show when={policyMode() === "fourEyes"}>
                              <PrincipalInput
                                label={t().approverGroup}
                                description={t().approverGroupDetail}
                                value={approverGroup() ? [approverGroup()!] : null}
                                multi={false}
                                types={["group"]}
                                disabled={policyMut.loading()}
                                onChange={(value) => setApproverGroup(value?.[0] ?? null)}
                              />
                            </Show>
                          </div>
                        </div>
                        <div class="flex w-full flex-wrap items-center gap-2">
                          <Show when={enabled().canDisable}>
                            <Button
                              variant="secondary"
                              size="sm"
                              type="button"
                              onClick={() => void changeFinalization("disable")}
                              loading={finalizationMut.loading()}
                              loadingLabel={t().disablingFinalization}
                            >
                              {t().disableFinalization}
                            </Button>
                          </Show>
                          <Show when={policyChanged()}>
                            <Button
                              class="ml-auto"
                              variant="primary"
                              size="sm"
                              type="button"
                              onClick={() => void savePolicy()}
                              loading={policyMut.loading()}
                              loadingLabel={t().savingFinalizationMode}
                              disabled={policyMode() === "fourEyes" && !approverGroup()}
                            >
                              <i class="ti ti-device-floppy" aria-hidden="true" /> {t().saveFinalizationMode}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )}
                  </Show>
                )}
              </Show>
            </PanelDialog.Section>
          </Show>
        </Show>
      </Show>
    </PanelDialog.Body>
  );
}
