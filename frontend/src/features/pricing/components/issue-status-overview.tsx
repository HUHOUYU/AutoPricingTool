import { RefreshCw } from "lucide-react";
import { IssueDetailsDialog } from "@/components/ui/issue-details-dialog";
import {
  DecisionReason,
  ValidationMessage,
} from "@/features/pricing/components/decision-reason";
import {
  quantityIssueDetails,
  unmatchedIssueDetails,
  type IssueDetailsRequest,
} from "@/features/pricing/issues";
import type { MappingValidationState } from "@/features/pricing/components/mapping-editor";
import { formatCoverage } from "@/features/workbench/file-utils";
import type { FileResult } from "@/features/workbench/types";
import type {
  PriceAnalysisFile,
  PricePreviewWritebackRow,
  PriceUnmatchedIssue,
} from "@shared/desktop-api";

type IssueStatusOverviewProps = {
  analysis: PriceAnalysisFile | undefined;
  hasMapping: boolean;
  issueDetailsRequest: IssueDetailsRequest | null;
  quantityIssues: PricePreviewWritebackRow[];
  result: FileResult | undefined;
  unmatchedIssues: PriceUnmatchedIssue[];
  validation: MappingValidationState;
  onCloseIssueDetails: () => void;
  onOpenUnmatchedDetails: (summary: string) => void;
  onUseOriginalSkuQuantity: (rows: PricePreviewWritebackRow[]) => void;
  onRevalidate: () => void;
};

export function IssueStatusOverview({
  analysis,
  hasMapping,
  issueDetailsRequest,
  quantityIssues,
  result,
  unmatchedIssues,
  validation,
  onCloseIssueDetails,
  onOpenUnmatchedDetails,
  onUseOriginalSkuQuantity,
  onRevalidate,
}: IssueStatusOverviewProps): React.JSX.Element {
  const liveValidation = validation.result;
  const validationErrors = liveValidation?.errors ?? [];
  const validationMessages = liveValidation
    ? liveValidation.requestVersion === 0
      ? validationErrors
      : [...validationErrors, ...(liveValidation.warnings ?? [])]
    : [];
  const uniqueValidationMessages = Array.from(new Set(
    validationMessages.map((message) => message.trim()).filter(Boolean),
  ));
  const validationMessageSet = new Set(uniqueValidationMessages);
  const visibleDecisionReasons = (analysis?.automationDecision.reasons ?? [])
    .filter((reason, index, reasons) => (
      !validationMessageSet.has(reason.trim())
      && reasons.findIndex((candidate) => candidate.trim() === reason.trim()) === index
    ));
  const trialMatched = liveValidation?.matchedRows ?? analysis?.automationDecision.matchedRows;
  const trialEvaluated = liveValidation?.evaluatedRows ?? analysis?.automationDecision.evaluatedRows;
  const trialCoverage = liveValidation?.coverage ?? analysis?.automationDecision.coverage;
  const trialTone = !liveValidation
    ? "is-idle"
    : validationErrors.length
      ? "is-error"
      : liveValidation.requestVersion > 0 && (liveValidation.warnings?.length ?? 0) > 0
        ? "is-warning"
        : validation.status === "stale"
          ? "is-stale"
          : "is-success";
  const decisionStatus = analysis?.automationDecision.status;
  const decisionLabel = decisionStatus === "eligible"
    ? "可自动"
    : decisionStatus === "confirm"
      ? "需确认"
      : decisionStatus === "error"
        ? "异常"
        : "未分析";
  const selectedIssueDetails = issueDetailsRequest?.kind === "quantity"
    ? quantityIssueDetails(quantityIssues)
    : unmatchedIssueDetails(unmatchedIssues);

  return (
    <section className="issue-status-section" aria-label="状态概览">
      <div className="issue-status-main">
        <span className={`issue-status-badge is-${decisionStatus ?? "idle"}`}>{decisionLabel}</span>
        <div className={`issue-status-trial ${trialTone}`}>
          <strong>
            {trialMatched !== undefined && trialEvaluated !== undefined
              ? `试算 ${trialMatched}/${trialEvaluated} 行 · ${formatCoverage(trialCoverage ?? 0)}`
              : "试算 —"}
          </strong>
          {hasMapping ? (
            <button
              type="button"
              className={`mapping-validation-state is-${validation.status}`}
              title="字段变更后会自动试算，也可以点击立即试算"
              disabled={validation.status === "validating"}
              onClick={onRevalidate}
            >
              <RefreshCw />
              {validation.status === "validating"
                ? "正在试算"
                : validation.status === "stale"
                  ? "立即试算"
                  : "重新试算"}
            </button>
          ) : null}
        </div>
      </div>

      {result ? (
        <div className="issue-status-metrics" aria-label="处理结果">
          <span><b>{result.totalRows ?? 0}</b><em>总行</em></span>
          <span><b>{result.matchedRows ?? 0}</b><em>匹配</em></span>
          <span className={(result.exceptionRows ?? 0) > 0 ? "is-alert" : undefined}>
            <b>{result.exceptionRows ?? 0}</b><em>异常</em>
          </span>
        </div>
      ) : null}

      {result?.message ? <p className="issue-status-message">{result.message}</p> : null}

      {uniqueValidationMessages.length > 0 ? (
        <div className={`issue-status-messages ${trialTone}`}>
          {uniqueValidationMessages.map((message) => (
            <ValidationMessage
              message={message}
              quantityIssues={quantityIssues}
              unmatchedIssues={unmatchedIssues}
              onOpenUnmatchedDetails={onOpenUnmatchedDetails}
              onUseOriginalSkuQuantity={onUseOriginalSkuQuantity}
              key={message}
            />
          ))}
        </div>
      ) : null}

      {analysis && visibleDecisionReasons.length > 0 ? (
        <ul className="decision-reasons is-compact">
          {visibleDecisionReasons.map((reason) => (
            <DecisionReason
              reason={reason}
              bestScore={analysis.automationDecision.candidateScore}
              runnerUpScore={analysis.automationDecision.runnerUpScore}
              scoreKind={analysis.automationDecision.scoreKind}
              quantityIssues={quantityIssues}
              unmatchedIssues={unmatchedIssues}
              onOpenUnmatchedDetails={onOpenUnmatchedDetails}
              onUseOriginalSkuQuantity={onUseOriginalSkuQuantity}
              key={reason}
            />
          ))}
        </ul>
      ) : null}

      <IssueDetailsDialog
        open={issueDetailsRequest !== null && (
          issueDetailsRequest.kind === "quantity"
            ? quantityIssues.length > 0
            : unmatchedIssues.length > 0
        )}
        title={issueDetailsRequest?.kind === "quantity" ? "数量计算问题" : "价格未匹配详情"}
        summary={issueDetailsRequest?.summary ?? ""}
        issues={selectedIssueDetails}
        selectedSourceRow={issueDetailsRequest?.sourceRow}
        actionLabel={issueDetailsRequest?.kind === "quantity"
          ? "使用原始 SKU 和数量"
          : undefined}
        onAction={issueDetailsRequest?.kind === "quantity"
          ? () => {
              onUseOriginalSkuQuantity(quantityIssues);
              onCloseIssueDetails();
            }
          : undefined}
        onClose={onCloseIssueDetails}
      />
    </section>
  );
}
