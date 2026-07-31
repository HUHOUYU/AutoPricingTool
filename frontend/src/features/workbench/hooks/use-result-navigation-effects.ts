import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { FileTab } from "@/stores/ui-store";
import { pickBestResultTab, tabForStatus } from "../status";
import {
  RESULT_REVEAL_HIGHLIGHT_MS,
  type FileStatus,
  type IssueReviewTab,
  type ManualIssueReviewResolution,
} from "../types";
import type { ProcessorSession } from "./use-processor-session";

type CurrentValue<T> = { current: T };
type RowVirtualizer = {
  scrollToIndex: (index: number, options: { align: "center" }) => void;
};

type ResolveManualReviewTargetOptions = {
  resolution: ManualIssueReviewResolution;
  files: string[];
  fileStatusByPath: Record<string, FileStatus>;
};

export function resolveManualReviewTarget({
  resolution,
  files,
  fileStatusByPath,
}: ResolveManualReviewTargetOptions): {
  path: string | null;
  tab: IssueReviewTab | null;
} {
  const { path, preferredTab, outcome } = resolution;
  const currentStatus = fileStatusByPath[path];
  const currentTab = currentStatus ? tabForStatus(currentStatus) : preferredTab;
  const currentStillNeedsReview = currentTab === "confirm" || currentTab === "error";

  if (outcome === "failed") return { path, tab: "error" };
  if (outcome !== "completed" || currentStillNeedsReview) {
    return {
      path,
      tab: currentStillNeedsReview ? currentTab : preferredTab,
    };
  }

  const currentIndex = files.indexOf(path);
  const orderedPaths = currentIndex < 0
    ? files
    : [...files.slice(currentIndex + 1), ...files.slice(0, currentIndex)];
  const findInTab = (tab: IssueReviewTab): string | undefined =>
    orderedPaths.find((candidate) => tabForStatus(fileStatusByPath[candidate]) === tab);
  const alternateTab: IssueReviewTab = preferredTab === "confirm" ? "error" : "confirm";
  const targetPath = findInTab(preferredTab) ?? findInTab(alternateTab) ?? null;
  return {
    path: targetPath,
    tab: targetPath
      ? tabForStatus(fileStatusByPath[targetPath]) as IssueReviewTab
      : null,
  };
}

type UseResultNavigationEffectsOptions = {
  session: ProcessorSession;
  files: string[];
  fileStatusByPath: Record<string, FileStatus>;
  visibleFiles: string[];
  tabCounts: Record<FileTab, number>;
  pageIndex: number;
  pageSize: number;
  setPageIndex: Dispatch<SetStateAction<number>>;
  pendingResultRevealPath: string | null;
  setPendingResultRevealPath: Dispatch<SetStateAction<string | null>>;
  setHighlightedResultPath: Dispatch<SetStateAction<string | null>>;
  tableScrollRef: RefObject<HTMLDivElement | null>;
  shouldVirtualizeRows: boolean;
  rowVirtualizer: RowVirtualizer;
  autoRevealManualResult: boolean;
  continuousIssueReviewEnabled: boolean;
  userTabLockedRef: CurrentValue<boolean>;
  batchTaskWasActiveRef: CurrentValue<boolean>;
  setActiveTab: (tab: FileTab) => void;
  openDetailDrawer: (path: string) => void;
};

export function useResultNavigationEffects({
  session,
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
}: UseResultNavigationEffectsOptions): void {
  const {
    analyses,
    batchStarted,
    isAnalyzing,
    isRunning,
    manualIssueReviewRef,
    manualIssueReviewResolution,
    setManualIssueReviewResolution,
  } = session;
  const resultRevealHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTaskActive = isAnalyzing || isRunning;

  useEffect(() => {
    if (continuousIssueReviewEnabled) return;
    manualIssueReviewRef.current = null;
    setManualIssueReviewResolution(null);
  }, [
    continuousIssueReviewEnabled,
    manualIssueReviewRef,
    setManualIssueReviewResolution,
  ]);

  useEffect(() => {
    if (!pendingResultRevealPath) return undefined;
    const targetIndex = visibleFiles.indexOf(pendingResultRevealPath);
    if (targetIndex < 0) return undefined;
    const targetPageIndex = Math.floor(targetIndex / pageSize);
    if (pageIndex !== targetPageIndex) {
      setPageIndex(targetPageIndex);
      return undefined;
    }

    const pageRowIndex = targetIndex - targetPageIndex * pageSize;
    if (shouldVirtualizeRows) rowVirtualizer.scrollToIndex(pageRowIndex, { align: "center" });
    let retryFrame = 0;
    const revealRow = (): boolean => {
      const rows = tableScrollRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-file-path]") ?? [];
      const row = Array.from(rows).find((candidate) => candidate.dataset.filePath === pendingResultRevealPath);
      if (!row) return false;
      row.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "nearest" });
      setHighlightedResultPath(pendingResultRevealPath);
      setPendingResultRevealPath(null);
      if (resultRevealHighlightTimerRef.current) clearTimeout(resultRevealHighlightTimerRef.current);
      resultRevealHighlightTimerRef.current = setTimeout(() => {
        setHighlightedResultPath((current) => (
          current === pendingResultRevealPath ? null : current
        ));
      }, RESULT_REVEAL_HIGHLIGHT_MS);
      return true;
    };
    const frame = requestAnimationFrame(() => {
      if (!revealRow()) retryFrame = requestAnimationFrame(revealRow);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (retryFrame) cancelAnimationFrame(retryFrame);
    };
  }, [
    pageIndex,
    pageSize,
    pendingResultRevealPath,
    rowVirtualizer,
    setHighlightedResultPath,
    setPageIndex,
    setPendingResultRevealPath,
    shouldVirtualizeRows,
    tableScrollRef,
    visibleFiles,
  ]);

  useEffect(() => () => {
    if (resultRevealHighlightTimerRef.current) clearTimeout(resultRevealHighlightTimerRef.current);
  }, []);

  useEffect(() => {
    if (!manualIssueReviewResolution) return;
    const { path, outcome } = manualIssueReviewResolution;
    const target = resolveManualReviewTarget({
      resolution: manualIssueReviewResolution,
      files,
      fileStatusByPath,
    });

    setManualIssueReviewResolution(null);
    if (!target.path || !target.tab) {
      if (outcome === "completed" && autoRevealManualResult) {
        setActiveTab("success");
        setPendingResultRevealPath(path);
      }
      return;
    }

    userTabLockedRef.current = true;
    setActiveTab(target.tab);
    const targetFiles = files.filter((candidate) => (
      tabForStatus(fileStatusByPath[candidate]) === target.tab
    ));
    const targetIndex = targetFiles.indexOf(target.path);
    setPageIndex(targetIndex < 0 ? 0 : Math.floor(targetIndex / pageSize));
    openDetailDrawer(target.path);
    setHighlightedResultPath(target.path);
    if (resultRevealHighlightTimerRef.current) clearTimeout(resultRevealHighlightTimerRef.current);
    resultRevealHighlightTimerRef.current = setTimeout(() => {
      setHighlightedResultPath((current) => current === target.path ? null : current);
    }, RESULT_REVEAL_HIGHLIGHT_MS);
  }, [
    autoRevealManualResult,
    fileStatusByPath,
    files,
    manualIssueReviewResolution,
    openDetailDrawer,
    pageSize,
    setActiveTab,
    setHighlightedResultPath,
    setManualIssueReviewResolution,
    setPageIndex,
    setPendingResultRevealPath,
    userTabLockedRef,
  ]);

  // 批次从运行中结束时：自动切到有结果的 Tab，仅单个真实待确认文件打开详情。
  useEffect(() => {
    if (isTaskActive) {
      batchTaskWasActiveRef.current = true;
      return;
    }
    if (!batchTaskWasActiveRef.current || !batchStarted) return;
    batchTaskWasActiveRef.current = false;
    if (userTabLockedRef.current) return;

    const nextTab = pickBestResultTab(tabCounts);
    if (nextTab) setActiveTab(nextTab);

    const confirmPaths = files.filter((path) => (
      analyses[path]?.automationDecision.status === "confirm"
      && tabForStatus(fileStatusByPath[path]) === "confirm"
    ));
    if (confirmPaths.length === 1) openDetailDrawer(confirmPaths[0]!);
  }, [
    analyses,
    batchStarted,
    batchTaskWasActiveRef,
    fileStatusByPath,
    files,
    isTaskActive,
    openDetailDrawer,
    setActiveTab,
    tabCounts,
    userTabLockedRef,
  ]);
}
