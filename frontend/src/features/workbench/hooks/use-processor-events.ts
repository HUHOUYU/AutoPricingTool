import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { FileTab } from "@/stores/ui-store";
import { normalizeAlternativeOrderColumns } from "@/features/pricing/mapping";
import type {
  PriceCheckMapping,
  ProcessorEvent,
} from "@shared/desktop-api";
import { fileNameFromPath, formatCoverage, getDesktopAPI } from "../file-utils";
import type { ProcessorSession } from "./use-processor-session";
import type { FileResult, LogEntry } from "../types";

type UseProcessorEventsOptions = {
  autoRevealManualResult: boolean;
  continuousIssueReviewEnabled: boolean;
  session: ProcessorSession;
  setHistoryRevision: Dispatch<SetStateAction<number>>;
  setPendingResultRevealPath: Dispatch<SetStateAction<string | null>>;
  setActiveTab: (tab: FileTab) => void;
  appendLog: (message: string, level?: LogEntry["level"]) => void;
  sendMappingValidation: (path: string, mapping: PriceCheckMapping, version: number) => void;
};

export function useProcessorEvents({
  autoRevealManualResult,
  continuousIssueReviewEnabled,
  session,
  setHistoryRevision,
  setPendingResultRevealPath,
  setActiveTab,
  appendLog,
  sendMappingValidation,
}: UseProcessorEventsOptions): void {
  const {
    analysesRef,
    mappingsRef,
    resultsRef,
    writebackEditsRef,
    confirmedPathsRef,
    manualIssueReviewRef,
    mappingValidationVersionsRef,
    priceRowValidationVersionsRef,
    mappingValidationInFlightRef,
    activeMappingValidationRef,
    pendingMappingValidationRef,
    setAnalyses,
    setMappings,
    setResults,
    setWritebackEdits,
    setMappingValidations,
    setMatchedOrderRowsBySheet,
    setActivePath,
    setProgress,
    setIsAnalyzing,
    setIsRunning,
    setIsPaused,
    setManualIssueReviewResolution,
    setAnalysisCompletedToken,
  } = session;
  const handleProcessorEvent = useCallback(
    (event: ProcessorEvent): void => {
      if (event.type === "price-analysis" || event.type === "price-mapping-required") {
        const analysis = event.file;
        const nextAnalyses = { ...analysesRef.current, [analysis.inputPath]: analysis };
        analysesRef.current = nextAnalyses;
        setAnalyses(nextAnalyses);
        if (analysis.suggestedMapping) {
          const suggestedMapping = normalizeAlternativeOrderColumns(analysis.suggestedMapping as PriceCheckMapping);
          const nextMappings = {
            ...mappingsRef.current,
            [analysis.inputPath]: suggestedMapping,
          };
          mappingsRef.current = nextMappings;
          setMappings(nextMappings);
          mappingValidationVersionsRef.current[analysis.inputPath] = 0;
          setMappingValidations((current) => ({
            ...current,
            [analysis.inputPath]: {
              status: "ready",
              result: {
                inputPath: analysis.inputPath,
                requestVersion: 0,
                evaluatedRows: analysis.automationDecision.evaluatedRows,
                matchedRows: analysis.automationDecision.matchedRows,
                coverage: analysis.automationDecision.coverage,
                matchedOrderRows: analysis.matchedOrderRows ?? [],
                writebackRows: analysis.writebackRows ?? [],
                unmatchedRows: analysis.unmatchedRows ?? [],
                singleShipmentMatching: analysis.singleShipmentMatching ?? null,
                errors: [],
                warnings: analysis.automationDecision.reasons,
              },
            },
          }));
          setMatchedOrderRowsBySheet((current) => ({
            ...current,
            [analysis.inputPath]: {
              ...current[analysis.inputPath],
              [suggestedMapping.orderSheet]: analysis.matchedOrderRows ?? [],
            },
          }));
        }
        if (event.type === "price-analysis") {
          appendLog(
            analysis.fileName +
              "：订单候选 " +
              analysis.orderSheetCandidates.length +
              " 个，核价候选 " +
              analysis.pricingSheetCandidates.length +
              " 个，覆盖率 " +
              formatCoverage(analysis.coverage),
            analysis.requiresConfirmation ? "warning" : "success",
          );
        } else {
          appendLog(analysis.fileName + "：需要确认字段映射或核价候选", "warning");
        }
        return;
      }
      if (event.type === "price-validation") {
        mappingValidationInFlightRef.current = false;
        activeMappingValidationRef.current = null;
        const currentVersion = mappingValidationVersionsRef.current[event.inputPath] ?? 0;
        if (event.requestVersion === currentVersion) {
          setMappingValidations((current) => ({ ...current, [event.inputPath]: { status: "ready", result: event } }));
          const orderSheet = mappingsRef.current[event.inputPath]?.orderSheet;
          if (orderSheet && event.errors.length === 0 && event.matchedOrderRows) {
            setMatchedOrderRowsBySheet((current) => ({
              ...current,
              [event.inputPath]: { ...current[event.inputPath], [orderSheet]: event.matchedOrderRows ?? [] },
            }));
          }
        }
        const pending = pendingMappingValidationRef.current;
        pendingMappingValidationRef.current = null;
        if (pending) setTimeout(() => sendMappingValidation(pending.path, pending.mapping, pending.version), 50);
        return;
      }
      if (event.type === "price-row-validation") {
        const versionKey = `${event.inputPath}\u0000${event.sourceRow}`;
        if (priceRowValidationVersionsRef.current[versionKey] !== event.requestVersion) return;
        if (event.row) {
          const currentRows = writebackEditsRef.current[event.inputPath] ?? [];
          const nextRows = [
            ...currentRows.filter((row) => row.sourceRow !== event.sourceRow),
            event.row,
          ].sort((left, right) => left.sourceRow - right.sourceRow);
          const next = { ...writebackEditsRef.current, [event.inputPath]: nextRows };
          writebackEditsRef.current = next;
          setWritebackEdits(next);
        }
        if (event.error) {
          toast.error(`第 ${event.sourceRow} 行重新核价失败：${event.error}`);
        }
        return;
      }
      if (event.type === "price-progress") {
        setActivePath(event.path);
        setProgress((current) => event.phase === "rows"
          ? { ...current, phase: event.phase, path: event.path }
          : { current: event.current, total: event.total, phase: event.phase, path: event.path });
        return;
      }
      if (event.type === "price-file-result") {
        setHistoryRevision((current) => current + 1);
        const result: FileResult = {
          path: event.path,
          status: event.status,
          outputPath: event.outputPath,
          totalRows: event.totalRows,
          matchedRows: event.matchedRows,
          exceptionRows: event.exceptionRows,
          coverage: event.coverage,
          message: event.message,
          completedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        };
        resultsRef.current = { ...resultsRef.current, [event.path]: result };
        setResults((current) => ({ ...current, [event.path]: result }));
        const manualReview = manualIssueReviewRef.current;
        const isContinuousManualReview = continuousIssueReviewEnabled
          && manualReview?.phase === "run"
          && manualReview.path === event.path;
        if (isContinuousManualReview && manualReview) {
          manualReview.outcome = event.status;
        }
        if (autoRevealManualResult && confirmedPathsRef.current.has(event.path) && !isContinuousManualReview) {
          setActiveTab(event.status === "completed" ? "success" : "error");
          setPendingResultRevealPath(event.path);
        }
        appendLog(
          event.status === "completed"
            ? fileNameFromPath(event.path) +
                "：完成 " +
                (event.matchedRows ?? 0) +
                "/" +
                (event.totalRows ?? 0) +
                " 行" +
                ((event.exceptionRows ?? 0) > 0 ? "，有异常待复核" : "")
            : fileNameFromPath(event.path) + "：" + (event.message ?? "核价失败"),
          event.status === "completed" && (event.exceptionRows ?? 0) === 0 ? "success" : event.status === "completed" ? "warning" : "error",
        );
        return;
      }
      if (event.type === "price-done") {
        if (event.mode === "run") setHistoryRevision((current) => current + 1);
        setActivePath("");
        if (event.mode === "analysis") {
          setIsAnalyzing(false);
          setIsPaused(false);
          const manualReview = manualIssueReviewRef.current;
          if (manualReview?.phase === "analysis") {
            if (event.stopped) {
              manualIssueReviewRef.current = null;
              setManualIssueReviewResolution({
                path: manualReview.path,
                preferredTab: manualReview.preferredTab,
                outcome: "unresolved",
              });
            } else {
              const decision = analysesRef.current[manualReview.path]?.automationDecision.status;
              if (decision === "eligible") {
                manualReview.phase = "run";
              } else {
                manualIssueReviewRef.current = null;
                setManualIssueReviewResolution({
                  path: manualReview.path,
                  preferredTab: manualReview.preferredTab,
                  outcome: "unresolved",
                });
              }
            }
          }
          appendLog(event.stopped ? "分析已停止" : "分析完成，请检查待确认文件", event.stopped ? "warning" : "success");
          if (!event.stopped) setAnalysisCompletedToken((current) => current + 1);
        } else {
          setIsRunning(false);
          setIsPaused(false);
          const manualReview = manualIssueReviewRef.current;
          if (manualReview?.phase === "run") {
            manualIssueReviewRef.current = null;
            setManualIssueReviewResolution({
              path: manualReview.path,
              preferredTab: manualReview.preferredTab,
              outcome: !event.stopped && manualReview.outcome === "completed" ? "completed" : "failed",
            });
          }
          setProgress((current) => event.stopped
            ? { ...current, path: "" }
            : { ...current, current: current.total, phase: "run", path: "" });
          appendLog(event.stopped ? "核价已停止" : "核价完成", event.stopped ? "warning" : "success");
          if (!event.stopped) {
            const completedCount = event.files.filter((item) => (
              Number(item.exceptionRows ?? 0) === 0 ||
              (typeof item.path === "string" && confirmedPathsRef.current.has(item.path))
            )).length;
            const exceptionCount = event.files.filter((item) => (
              Number(item.exceptionRows ?? 0) > 0 &&
              !(typeof item.path === "string" && confirmedPathsRef.current.has(item.path))
            )).length + (event.failures?.length ?? 0);
            const confirmCount = Object.values(analysesRef.current).filter((analysis) => analysis.automationDecision.status === "confirm").length;
            toast.success(`批次完成：完成 ${completedCount}，待确认 ${confirmCount}，异常 ${exceptionCount}`);
          }
        }
        return;
      }
      if (event.type === "state") {
        if (event.state === "paused") setIsPaused(true);
        if (event.state === "running") setIsPaused(false);
        if (event.state === "idle" || event.state === "exited") {
          setIsAnalyzing(false);
          setIsRunning(false);
          setIsPaused(false);
          setActivePath("");
        }
        return;
      }
      if (event.type === "log") {
        appendLog(event.message, event.level ?? "info");
        return;
      }
      if (event.type === "error") {
        const activeValidation = activeMappingValidationRef.current;
        if (activeValidation) {
          mappingValidationInFlightRef.current = false;
          activeMappingValidationRef.current = null;
          setMappingValidations((current) => ({
            ...current,
            [activeValidation.path]: {
              status: "ready",
              result: {
                inputPath: activeValidation.path,
                requestVersion: activeValidation.version,
                evaluatedRows: 0,
                matchedRows: 0,
                coverage: 0,
                errors: ["试算请求失败：" + (event.userMessage ?? event.message)],
                warnings: [],
              },
            },
          }));
          const pending = pendingMappingValidationRef.current;
          pendingMappingValidationRef.current = null;
          if (pending) setTimeout(() => sendMappingValidation(pending.path, pending.mapping, pending.version), 50);
          appendLog(event.userMessage ?? event.message, "error");
          return;
        }
        setIsAnalyzing(false);
        setIsRunning(false);
        setIsPaused(false);
        setActivePath("");
        const manualReview = manualIssueReviewRef.current;
        if (manualReview) {
          manualIssueReviewRef.current = null;
          setManualIssueReviewResolution({
            path: manualReview.path,
            preferredTab: manualReview.preferredTab,
            outcome: "failed",
          });
        }
        appendLog(event.userMessage ?? event.message, "error");
      }
    },
    [
      activeMappingValidationRef,
      analysesRef,
      appendLog,
      autoRevealManualResult,
      confirmedPathsRef,
      continuousIssueReviewEnabled,
      manualIssueReviewRef,
      mappingValidationInFlightRef,
      mappingValidationVersionsRef,
      mappingsRef,
      pendingMappingValidationRef,
      priceRowValidationVersionsRef,
      resultsRef,
      sendMappingValidation,
      setActiveTab,
      writebackEditsRef,
    ],
  );

  useEffect(() => {
    const api = getDesktopAPI();
    return api?.onProcessorEvent(handleProcessorEvent);
  }, [handleProcessorEvent]);
}
