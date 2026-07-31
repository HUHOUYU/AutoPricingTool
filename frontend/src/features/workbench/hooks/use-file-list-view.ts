import { useMemo } from "react";
import type { PriceAnalysisFile } from "@shared/desktop-api";
import type { FileTab } from "@/stores/ui-store";
import { fileNameFromPath } from "../file-utils";
import { statusForFile, tabForStatus } from "../status";
import type { DotStatus, FileResult, FileStatus, ProgressDot } from "../types";

type UseFileListViewOptions = {
  files: string[];
  analyses: Record<string, PriceAnalysisFile>;
  results: Record<string, FileResult>;
  activePath: string;
  busy: boolean;
  pricing: boolean;
  confirmedPaths: ReadonlySet<string>;
  activeTab: FileTab;
  pageIndex: number;
  pageSize: number;
};

export function useFileListView({
  files,
  analyses,
  results,
  activePath,
  busy,
  pricing,
  confirmedPaths,
  activeTab,
  pageIndex,
  pageSize,
}: UseFileListViewOptions): {
  fileStatusByPath: Record<string, FileStatus>;
  progressDots: ProgressDot[];
  progressDotCounts: Record<DotStatus, number>;
  tabCounts: Record<FileTab, number>;
  visibleFiles: string[];
  pagedFiles: string[];
  pageCount: number;
} {
  const fileStatusByPath = useMemo<Record<string, FileStatus>>(
    () =>
      Object.fromEntries(
        files.map((path) => [
          path,
          statusForFile(
            path,
            analyses[path],
            results[path],
            activePath,
            busy,
            confirmedPaths.has(path),
            pricing,
          ),
        ]),
      ),
    [activePath, analyses, busy, confirmedPaths, files, pricing, results],
  );

  const progressDots = useMemo<ProgressDot[]>(
    () => files.map((path) => ({ path, label: fileNameFromPath(path), status: fileStatusByPath[path] })),
    [fileStatusByPath, files],
  );

  const progressDotCounts = useMemo(
    () =>
      progressDots.reduce<Record<DotStatus, number>>(
        (counts, dot) => {
          counts[dot.status] += 1;
          return counts;
        },
        { pending: 0, queued: 0, running: 0, pricing: 0, ready: 0, success: 0, warning: 0, error: 0 },
      ),
    [progressDots],
  );

  const tabCounts = useMemo<Record<FileTab, number>>(
    () =>
      progressDots.reduce<Record<FileTab, number>>(
        (counts, dot) => {
          counts[tabForStatus(dot.status)] += 1;
          return counts;
        },
        { pending: 0, queued: 0, confirm: 0, error: 0, success: 0 },
      ),
    [progressDots],
  );

  const visibleFiles = useMemo(
    () => files.filter((path) => tabForStatus(fileStatusByPath[path]) === activeTab),
    [activeTab, fileStatusByPath, files],
  );

  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / pageSize));
  const pagedFiles = useMemo(
    () => visibleFiles.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [pageIndex, pageSize, visibleFiles],
  );

  return {
    fileStatusByPath,
    progressDots,
    progressDotCounts,
    tabCounts,
    visibleFiles,
    pagedFiles,
    pageCount,
  };
}
