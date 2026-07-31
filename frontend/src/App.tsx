import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Columns3,
  Download,
  ScanSearch,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { ProgressChart } from "@/features/workbench/components/progress-chart";
import { PricingDetailDrawer } from "@/features/pricing/components/pricing-detail-drawer";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUIStore, type FileTab } from "@/stores/ui-store";
import { IconAction } from "@/app/components/icon-action";
import { AppPageContent } from "@/app/components/app-page-content";
import { AppShell } from "@/app/components/app-shell";
import { useAppSettings } from "@/app/hooks/use-app-settings";
import { TaskActions } from "@/features/workbench/components/task-actions";
import { BatchUploadPanel } from "@/features/workbench/components/batch-upload-panel";
import { WorkbenchFileTable } from "@/features/workbench/components/file-table";
import {
  BatchFileToolbar,
  BatchProgressPanel,
  WorkbenchPagination,
} from "@/features/workbench/components/workbench-panels";
import {
  excelColumnLetter,
  quantityIssueMessage,
} from "@/features/pricing/issues";
import { summarizeWritebackAlerts } from "@/features/pricing/writeback-status";
import { useDetailDrawerLayout } from "@/features/workbench/hooks/use-detail-drawer-layout";
import { useBatchNextAction } from "@/features/workbench/hooks/use-batch-next-action";
import { useBatchFileActions } from "@/features/workbench/hooks/use-batch-file-actions";
import { useBatchLayoutAnimation } from "@/features/workbench/hooks/use-batch-layout-animation";
import { useBatchLifecycleActions } from "@/features/workbench/hooks/use-batch-lifecycle-actions";
import { useBatchScanAction } from "@/features/workbench/hooks/use-batch-scan-action";
import { useFileImportActions } from "@/features/workbench/hooks/use-file-import-actions";
import { useFileTableModel } from "@/features/workbench/hooks/use-file-table-model";
import { useFileListView } from "@/features/workbench/hooks/use-file-list-view";
import { useProcessingCommands } from "@/features/workbench/hooks/use-processing-commands";
import { useProcessingAutoRun } from "@/features/workbench/hooks/use-processing-auto-run";
import { useProcessorEvents } from "@/features/workbench/hooks/use-processor-events";
import { useProcessorSession } from "@/features/workbench/hooks/use-processor-session";
import { useResultNavigationEffects } from "@/features/workbench/hooks/use-result-navigation-effects";
import { useTaskControls } from "@/features/workbench/hooks/use-task-controls";
import { usePricingDetailState } from "@/features/pricing/hooks/use-pricing-detail-state";
import { useMappingValidationActions } from "@/features/pricing/hooks/use-mapping-validation-actions";
import { useMappingReviewActions } from "@/features/pricing/hooks/use-mapping-review-actions";
import { useMappingDetailActions } from "@/features/pricing/hooks/use-mapping-detail-actions";
import {
  columnLabel,
  defaultDraftBatchName,
  getDesktopAPI,
  parentDirectory,
} from "@/features/workbench/file-utils";
import {
  dotStatusLabels,
  fileTabs,
  type FileStatus,
  type ImportMode,
  type ImportSourceMode,
  type LogEntry,
} from "@/features/workbench/types";
import type { ConfigDocument, PriceUnmatchedIssue } from "@shared/desktop-api";

export function App(): React.JSX.Element {
  const shellRef = useRef<HTMLElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const processorSession = useProcessorSession();
  const {
    analyses, analysesRef,
    mappings,
    results,
    isAnalyzing,
    isRunning,
    isPaused,
    batchStarted,
    batchId,
    activePath,
    expandedPath, setExpandedPath,
    progress,
    mappingValidations,
    matchedOrderRowsBySheet,
    writebackEdits,
    cellEdits,
    confirmedPathsRef,
    autoRunRequestedRef, autoRunTargetPathsRef,
  } = processorSession;
  const [inputDirectorySelected, setInputDirectorySelected] = useState(false);
  const [importSourceMode, setImportSourceMode] = useState<ImportSourceMode>("file");
  const [pendingResultRevealPath, setPendingResultRevealPath] = useState<string | null>(null);
  const [highlightedResultPath, setHighlightedResultPath] = useState<string | null>(null);
  const { activeTab, setActiveTab, activePage, setActivePage, theme, toggleTheme, sidebarCollapsed, toggleSidebar } = useUIStore();
  const [batchName, setBatchName] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [editingBatchName, setEditingBatchName] = useState(false);
  const [importedAt, setImportedAt] = useState<Record<string, string>>({});
  const [importModes, setImportModes] = useState<Record<string, ImportMode>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [requestedHistoryBatchId, setRequestedHistoryBatchId] = useState<string | null>(null);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const detailDrawerLayout = useDetailDrawerLayout();
  const { resetDrawerWidth } = detailDrawerLayout;
  const pricingDetailState = usePricingDetailState({
    analyses,
    detailPath,
    mappings,
    mappingValidations,
    matchedOrderRowsBySheet,
    results,
    writebackEdits,
  });
  const {
    activeMappingTarget,
    mapping: detailMapping,
    previewSheetName: detailPreviewSheetName,
    setActiveMappingTarget,
    setPreviewSheetName: setDetailPreviewSheetName,
    setPreviewWorkbook: setDetailPreviewWorkbook,
  } = pricingDetailState;
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [nextBatchConfirmOpen, setNextBatchConfirmOpen] = useState(false);
  const userTabLockedRef = useRef(false);
  const batchTaskWasActiveRef = useRef(false);
  const batchNameEditedRef = useRef(false);
  const writebackAlertNoticeKeysRef = useRef<Set<string>>(new Set());
  const batchLayout = activePage !== "files" ? null : batchStarted ? "locked" : files.length > 0 ? "ready" : "empty";
  const workspaceRef = useBatchLayoutAnimation(batchLayout);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (!detailPath || pricingDetailState.validation.status !== "ready") return;
    const summary = summarizeWritebackAlerts(pricingDetailState.writebackRows);
    if (!summary.message) return;
    const noticeKey = `${detailPath}\u0000${summary.signature}`;
    if (writebackAlertNoticeKeysRef.current.has(noticeKey)) return;
    writebackAlertNoticeKeysRef.current.add(noticeKey);
    toast.warning(summary.message);
  }, [detailPath, pricingDetailState.validation.status, pricingDetailState.writebackRows]);

  const appendLog = useCallback((message: string, level: LogEntry["level"] = "info"): void => {
    setLogs((current) => [
      ...current,
      {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        message,
        level,
      },
    ].slice(-500));
  }, []);

  const {
    inputDirectory: inputDir,
    outputDirectory: outputDir,
    configPath,
    autoRevealManualResult,
    continuousIssueReviewEnabled,
    setInputDirectory: setInputDir,
    setOutputDirectory: setOutputDir,
    setConfigPath,
    applySettings: handleAppSettingsChanged,
  } = useAppSettings({
    activePage,
    appendLog,
  });

  const {
    sendMappingValidation,
    revalidateMapping,
    useOriginalSkuQuantity,
    commitMapping,
    updateMapping,
  } = useMappingValidationActions({
    session: processorSession,
    configPath,
  });

  useProcessorEvents({
    autoRevealManualResult,
    continuousIssueReviewEnabled,
    session: processorSession,
    setHistoryRevision,
    setPendingResultRevealPath,
    setActiveTab,
    appendLog,
    sendMappingValidation,
  });

  const {
    registerPaths,
    removeFile,
    selectedSet,
    actionFiles,
    toggleSelected,
    toggleAllSelected,
  } = useBatchFileActions({
    session: processorSession,
    files,
    setFiles,
    selectedPaths,
    setSelectedPaths,
    setImportedAt,
    setImportModes,
    batchStarted,
    setBatchName,
    setBatchNote,
    batchNameEditedRef,
    setInputDirectorySelected,
    setInputDirectory: setInputDir,
    activeTab,
    setActiveTab,
    appendLog,
    onResetFileView: (replaceBatch) => {
      setDetailPreviewWorkbook(null);
      setActiveMappingTarget(null);
      setDetailPath(null);
      setPageIndex(0);
      if (replaceBatch) {
        writebackAlertNoticeKeysRef.current.clear();
        setLogs([]);
        userTabLockedRef.current = false;
        batchTaskWasActiveRef.current = false;
      }
    },
    onRemoveFileView: (path) => {
      if (detailPath === path) setDetailPath(null);
      if (expandedPath === path) setExpandedPath(null);
    },
  });

  const {
    ensureOutputDirectory,
    chooseInputFiles,
    chooseInputDirectory,
    getRootProps,
    getInputProps,
    isDragActive,
  } = useFileImportActions({
    batchStarted,
    directorySelectionDisabled: isAnalyzing || isRunning,
    importSourceMode,
    outputDirectory: outputDir,
    registerPaths,
    appendLog,
    onOutputDirectoryChange: setOutputDir,
    onInputDirectoryChange: setInputDir,
    onInputDirectorySelectedChange: setInputDirectorySelected,
  });
  const { resetTask, chooseNextBatch } = useBatchLifecycleActions({
    session: processorSession,
    files,
    setFiles,
    setImportedAt,
    setImportModes,
    setSelectedPaths,
    batchName,
    setBatchName,
    batchNote,
    setBatchNote,
    setEditingBatchName,
    batchNameEditedRef,
    ensureOutputDirectory,
    setHistoryRevision,
    appendLog,
    onResetBatchView: () => {
      setDetailPath(null);
      userTabLockedRef.current = false;
      batchTaskWasActiveRef.current = false;
      setResetConfirmOpen(false);
      setNextBatchConfirmOpen(false);
      setInputDirectorySelected(false);
      setActiveTab("pending");
      setPageIndex(0);
      setLogs([]);
    },
  });
  const commitBatchName = async (): Promise<void> => {
    const nextName = batchName.trim() || defaultDraftBatchName(files, importSourceMode);
    batchNameEditedRef.current = true;
    setBatchName(nextName);
    setEditingBatchName(false);
    const api = getDesktopAPI();
    if (!api || !batchId) return;
    try {
      await api.updateTaskBatchMetadata({ batchId, name: nextName });
      setHistoryRevision((current) => current + 1);
    } catch (error) {
      toast.error(`批次名称保存失败：${String(error)}`);
    }
  };

  const { analyzeFiles, runPricing } = useProcessingCommands({
    session: processorSession,
    actionFiles,
    files,
    configPath,
    outputDirectory: outputDir,
    batchName,
    batchNote,
    ensureOutputDirectory,
    appendLog,
    setActiveTab,
    onClearAnalysisView: () => {
      setDetailPreviewWorkbook(null);
      setActiveMappingTarget(null);
    },
  });
  const { scanFiles } = useBatchScanAction({
    session: processorSession,
    actionFiles,
    inputDirectorySelected,
    inputDirectory: inputDir,
    setFiles,
    setImportedAt,
    setSelectedPaths,
    analyzeFiles,
    appendLog,
  });
  useProcessingAutoRun({
    session: processorSession,
    files,
    runPricing,
  });
  const { confirmAndContinue, retryAnalysis } = useMappingReviewActions({
    session: processorSession,
    continuousIssueReviewEnabled,
    analyzeFiles,
    runPricing,
    setActiveTab,
    onCloseDetail: () => setDetailPath(null),
  });

  const handleConfigDocumentSaved = async (document: ConfigDocument): Promise<void> => {
    setConfigPath(document.path);
    if (files.length === 0) return;
    if (isAnalyzing || isRunning) {
      appendLog("配置已保存；当前任务结束后请重新分析，使新配置应用到现有文件", "warning");
      toast.warning("配置已保存，当前任务结束后需要重新分析");
      return;
    }
    appendLog("配置已保存，正在按新配置重新分析已导入文件");
    toast.info("配置已生效，正在重新分析已导入文件");
    await analyzeFiles(files, document.path);
  };

  const openSourceDirectory = async (path: string): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const error = await api.openPath(parentDirectory(path));
    if (error) appendLog(error, "warning");
  };

  const requestResetTask = (): void => {
    setResetConfirmOpen(true);
  };

  const {
    fileStatusByPath,
    progressDots,
    progressDotCounts,
    tabCounts,
    visibleFiles,
    pagedFiles,
    pageCount,
  } = useFileListView({
    files,
    analyses,
    results,
    activePath,
    busy: isAnalyzing || isRunning,
    pricing: isRunning,
    confirmedPaths: confirmedPathsRef.current,
    activeTab,
    pageIndex,
    pageSize,
  });

  useEffect(() => {
    setPageIndex(0);
  }, [activeTab, pageSize]);

  const fileTableModel = useFileTableModel({
    files,
    pagedFiles,
    activeTab,
    analyses,
    mappings,
    results,
    importModes,
    importedAt,
    fileStatusByPath,
    expandedPath,
  });
  const {
    tableScrollRef,
    shouldVirtualizeRows,
    rowVirtualizer,
  } = fileTableModel;

  const completedDotCount = progressDotCounts.success + progressDotCounts.warning + progressDotCounts.error;
  const progressPercent = progress.total > 0
    ? Math.round(Math.min(1, progress.current / progress.total) * 100)
    : files.length > 0
      ? Math.round((completedDotCount / files.length) * 100)
      : 0;
  const totalMatched = useMemo(() => Object.values(results).reduce((sum, item) => sum + (item.matchedRows ?? 0), 0), [results]);
  const totalRows = useMemo(() => Object.values(results).reduce((sum, item) => sum + (item.totalRows ?? 0), 0), [results]);
  const matchedRate = totalRows > 0 ? ((totalMatched / totalRows) * 100).toFixed(1) + "%" : "—";
  const selectedAll = visibleFiles.length > 0 && visibleFiles.every((path) => selectedSet.has(path));
  const isTaskActive = isAnalyzing || isRunning;
  const hasResettableTaskState = files.length > 0 || logs.length > 0 || batchStarted;
  const phaseLabel = progress.phase === "analyze" ? "分析" : progress.phase === "rows" ? "写入" : progress.phase === "run" ? "核价" : "等待操作";
  const batchPhaseLabel = isPaused
    ? "任务已暂停"
    : isAnalyzing
      ? "正在分析文件"
      : isRunning
        ? "正在核价"
        : tabCounts.confirm > 0
          ? `分析完成 · ${tabCounts.confirm} 个文件待确认`
          : tabCounts.error > 0
            ? `分析完成 · ${tabCounts.error} 个异常`
            : tabCounts.queued > 0
              ? `分析完成 · ${tabCounts.queued} 个文件待核价`
            : tabCounts.success > 0
              ? "本批已完成"
              : Object.keys(analyses).length > 0
                ? "分析已完成"
                : "批次已停止";
  const mappingDetailActions = useMappingDetailActions({
    session: processorSession,
    configPath,
    detailPath,
    detailMapping,
    activeMappingTarget,
    detailPreviewSheetName,
    setActiveMappingTarget,
    setDetailPreviewSheetName,
    commitMapping,
  });

  const openDetailDrawer = useCallback((path: string): void => {
    resetDrawerWidth();
    setDetailPath(path);
  }, [resetDrawerWidth]);

  useResultNavigationEffects({
    session: processorSession,
    files,
    fileStatusByPath,
    visibleFiles,
    tabCounts,
    pageIndex,
    pageSize,
    setPageIndex,
    pendingResultRevealPath,
    setPendingResultRevealPath,
    setHighlightedResultPath,
    tableScrollRef,
    shouldVirtualizeRows,
    rowVirtualizer,
    autoRevealManualResult,
    continuousIssueReviewEnabled,
    userTabLockedRef,
    batchTaskWasActiveRef,
    setActiveTab,
    openDetailDrawer,
  });

  const hasAnalysis = useCallback(
    (path: string): boolean => Boolean(analysesRef.current[path] ?? analyses[path]),
    [analyses],
  );
  const batchNextAction = useBatchNextAction({
    batchStarted,
    isTaskActive,
    files,
    fileStatusByPath,
    results,
    tabCounts,
    hasAnalysis,
    onOpenConfirm: (confirmPaths) => {
      userTabLockedRef.current = true;
      setActiveTab("confirm");
      if (confirmPaths.length === 1) openDetailDrawer(confirmPaths[0]!);
    },
    onOpenErrors: () => {
      userTabLockedRef.current = true;
      setActiveTab("error");
    },
    onContinue: (unfinishedFiles, needsAnalysis) => {
      userTabLockedRef.current = false;
      if (needsAnalysis) {
        autoRunRequestedRef.current = true;
        autoRunTargetPathsRef.current = unfinishedFiles;
        void analyzeFiles(unfinishedFiles);
      } else {
        void runPricing(unfinishedFiles, "retry");
      }
    },
    onNextBatch: () => { void chooseNextBatch(); },
  });

  const listEmptyState = useMemo(() => {
    if (files.length === 0) {
      return {
        title: "暂无文件",
        detail: "导入后将在这里显示",
        action: null as null | { label: string; onClick: () => void },
      };
    }
    const otherTab = fileTabs.find((tab) => tab.key !== activeTab && tabCounts[tab.key] > 0);
    if (otherTab) {
      return {
        title: "本状态暂无文件",
        detail: `${otherTab.label}有 ${tabCounts[otherTab.key]} 个文件`,
        action: {
          label: `查看${otherTab.label} (${tabCounts[otherTab.key]})`,
          onClick: () => {
            userTabLockedRef.current = true;
            setActiveTab(otherTab.key);
          },
        },
      };
    }
    const currentLabel = fileTabs.find((tab) => tab.key === activeTab)?.label ?? "当前状态";
    return {
      title: `${currentLabel}暂无文件`,
      detail: "可切换其他状态查看，或重置本批后重新导入",
      action: null,
    };
  }, [activeTab, files.length, setActiveTab, tabCounts]);

  const {
    startCurrentTask,
    togglePauseTask,
    stopCurrentTask,
  } = useTaskControls({
    actionFiles,
    isAnalyzing,
    isRunning,
    isPaused,
    hasAnalysis,
    onPrepareAutoRun: (targetFiles) => {
      autoRunRequestedRef.current = true;
      autoRunTargetPathsRef.current = targetFiles;
    },
    onAnalyze: async (targetFiles) => analyzeFiles(targetFiles),
    onRun: async (targetFiles) => runPricing(targetFiles),
  });

  const renderTaskActions = (className: string, showReset = false, showNext = false): React.JSX.Element => {
    return (
      <TaskActions
        batchStarted={batchStarted}
        canReset={hasResettableTaskState}
        canStart={actionFiles.length > 0}
        className={className}
        collapsed={sidebarCollapsed}
        isPaused={isPaused}
        isTaskActive={isTaskActive}
        nextAction={batchNextAction}
        pendingReviewCount={tabCounts.confirm + tabCounts.error + tabCounts.queued + tabCounts.pending}
        showNext={showNext}
        showReset={showReset}
        onFinishBatch={() => setNextBatchConfirmOpen(true)}
        onPause={() => void togglePauseTask()}
        onReset={requestResetTask}
        onStart={() => {
          userTabLockedRef.current = false;
          void startCurrentTask();
        }}
        onStop={() => void stopCurrentTask()}
      />
    );
  };

  const showComingSoon = (label: string): void => {
    toast.info(label + "正在建设中");
  };

  return (
    <AppShell
      mainRef={shellRef}
      theme={theme}
      activePage={activePage}
      sidebarCollapsed={sidebarCollapsed}
      detailOpen={detailPath !== null}
      railActions={sidebarCollapsed && activePage === "files" && files.length > 0
        ? renderTaskActions("cyber-rail-actions", true)
        : undefined}
      onChangePage={setActivePage}
      onHelp={() => showComingSoon("帮助中心")}
      onToggleSidebar={toggleSidebar}
      onToggleTheme={toggleTheme}
    >

        <PricingDetailDrawer
          path={detailPath}
          fileStatus={detailPath ? fileStatusByPath[detailPath] : undefined}
          cellEdits={detailPath ? cellEdits[detailPath] ?? [] : []}
          state={pricingDetailState}
          layout={detailDrawerLayout}
          mappingActions={mappingDetailActions}
          onClose={() => setDetailPath(null)}
          onRevalidate={() => {
            if (detailPath) revalidateMapping(detailPath);
          }}
          onUseOriginalSkuQuantity={() => {
            if (detailPath) useOriginalSkuQuantity(detailPath, pricingDetailState.quantityIssues);
          }}
          onCommitMapping={(mapping) => {
            if (detailPath) commitMapping(detailPath, mapping);
          }}
          onUpdateMapping={(orderSheet, pricingSheet) => {
            if (detailPath) updateMapping(detailPath, orderSheet, pricingSheet);
          }}
          onConfirm={() => {
            if (detailPath) void confirmAndContinue(detailPath);
          }}
          onRetry={() => {
            if (detailPath) void retryAnalysis(detailPath);
          }}
        />

        <section ref={workspaceRef} className={`cyber-workspace is-${activePage}${activePage === "files" ? batchStarted ? " has-locked-batch" : files.length > 0 ? " has-ready-batch" : " has-empty-batch" : ""}` + (!["workbench", "files", "config", "templates", "logs", "analytics"].includes(activePage) ? " is-coming-soon" : "")}>
          {activePage === "files" ? <>
          <BatchUploadPanel
            visible={!batchStarted}
            fileCount={files.length}
            importSourceMode={importSourceMode}
            isDragActive={isDragActive}
            getRootProps={getRootProps}
            getInputProps={getInputProps}
            onChooseInput={() => importSourceMode === "file" ? void chooseInputFiles() : void chooseInputDirectory()}
            onToggleImportMode={() => setImportSourceMode((current) => current === "file" ? "folder" : "file")}
            actions={!sidebarCollapsed ? renderTaskActions("cyber-workbench-actions cyber-banner-actions", true) : null}
          />

          <section className="cyber-table-panel">
            <BatchFileToolbar
              visibleFileCount={visibleFiles.length}
              fileCount={files.length}
              batchId={batchId}
              batchName={batchName}
              defaultBatchName={defaultDraftBatchName(files, importSourceMode)}
              editingBatchName={editingBatchName}
              activeTab={activeTab}
              tabCounts={tabCounts}
              tableModel={fileTableModel}
              onBatchNameChange={setBatchName}
              onCommitBatchName={() => { void commitBatchName(); }}
              onCancelBatchName={() => {
                setBatchName(defaultDraftBatchName(files, importSourceMode));
                setEditingBatchName(false);
              }}
              onBeginBatchNameEdit={() => setEditingBatchName(true)}
              onTabChange={(tab) => {
                userTabLockedRef.current = true;
                setActiveTab(tab);
              }}
            />

            <BatchProgressPanel
              visible={batchStarted}
              taskActive={isTaskActive}
              phaseLabel={batchPhaseLabel}
              percent={progressPercent}
              current={progress.current}
              total={progress.total}
              fileCount={files.length}
              activePath={activePath}
              actions={!sidebarCollapsed
                ? renderTaskActions("cyber-workbench-actions cyber-progress-actions", true, true)
                : null}
            />

            <WorkbenchFileTable
              model={fileTableModel}
              activeTab={activeTab}
              analyses={analyses}
              mappings={mappings}
              results={results}
              importModes={importModes}
              importedAt={importedAt}
              fileStatusByPath={fileStatusByPath}
              selectedPaths={selectedSet}
              selectedAll={selectedAll}
              highlightedPath={highlightedResultPath}
              busy={isAnalyzing || isRunning}
              emptyState={listEmptyState}
              onToggleSelected={toggleSelected}
              onToggleAllSelected={toggleAllSelected}
              onOpenSource={(path) => void openSourceDirectory(path)}
              onOpenDetail={openDetailDrawer}
              onOpenOutput={(path) => void getDesktopAPI()?.openPath(path)}
              onRemove={removeFile}
            />

            <WorkbenchPagination
              itemCount={visibleFiles.length}
              pageIndex={pageIndex}
              pageSize={pageSize}
              pageCount={pageCount}
              onPageIndexChange={setPageIndex}
              onPageSizeChange={setPageSize}
            />
          </section>
          </> : (
            <AppPageContent
              activePage={activePage}
              dark={theme === "dark"}
              currentFileCount={files.length}
              outputDir={outputDir}
              historyRevision={historyRevision}
              requestedHistoryBatchId={requestedHistoryBatchId}
              onChangePage={setActivePage}
              onNewProcessing={() => {
                setActivePage("files");
                if (!batchStarted) void chooseInputFiles();
              }}
              onConfigDocumentSaved={handleConfigDocumentSaved}
              onAppSettingsChanged={handleAppSettingsChanged}
              onRequestedBatchHandled={() => setRequestedHistoryBatchId(null)}
              onOpenBatch={(batchId) => {
                setRequestedHistoryBatchId(batchId);
                setActivePage("logs");
              }}
            />
          )}
        </section>

        <ConfirmDialog
          open={resetConfirmOpen}
          title="重置本批？"
          description="将清空当前列表、分析结果与进度，且不可恢复。确认后可重新导入文件开始新批次。"
          confirmLabel="重置本批"
          tone="danger"
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => { void resetTask(); }}
        />
        <ConfirmDialog
          open={nextBatchConfirmOpen}
          title="结束当前批次？"
          description={`当前仍有 ${tabCounts.queued} 个待核价、${tabCounts.confirm} 个待确认、${tabCounts.error} 个异常、${tabCounts.pending} 个待分析文件。结束后，所有没有有效核价结果的文件将复制到当前批次结果目录的“未处理”文件夹，原始文件保持不变。`}
          confirmLabel="结束并归档"
          onCancel={() => setNextBatchConfirmOpen(false)}
          onConfirm={() => {
            setNextBatchConfirmOpen(false);
            void chooseNextBatch();
          }}
        />
    </AppShell>
  );
}
