import type { FileTab } from "@/stores/ui-store";

export type FileResult = {
  path: string;
  outputPath?: string;
  totalRows?: number;
  matchedRows?: number;
  exceptionRows?: number;
  coverage?: number;
  status: "completed" | "failed";
  message?: string;
  completedAt: string;
};

export type ImportMode = "file" | "folder" | "config";
export type ImportSourceMode = Exclude<ImportMode, "config">;

export type ImportSummary = {
  imported: number;
  duplicates: number;
};

export type RegisterPathsOptions = {
  replaceBatch?: boolean;
};

export type AnalyzeFilesOptions = {
  preserveExisting?: boolean;
};

export type LogEntry = {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
};

export type FileStatus = "pending" | "queued" | "running" | "pricing" | "ready" | "success" | "warning" | "error";
export type DotStatus = FileStatus;
export type IssueReviewTab = Extract<FileTab, "confirm" | "error">;

export type ManualIssueReviewContext = {
  path: string;
  preferredTab: IssueReviewTab;
  phase: "analysis" | "run";
  outcome?: "completed" | "failed";
};

export type ManualIssueReviewResolution = {
  path: string;
  preferredTab: IssueReviewTab;
  outcome: "completed" | "failed" | "unresolved";
};

export type ProgressDot = {
  path: string;
  status: DotStatus;
  label: string;
};

export const statusMeta: Record<FileStatus, { label: string; tone: FileStatus }> = {
  pending: { label: "待分析", tone: "pending" },
  queued: { label: "待核价", tone: "pending" },
  running: { label: "处理中", tone: "running" },
  pricing: { label: "核价中", tone: "running" },
  ready: { label: "待确认", tone: "ready" },
  success: { label: "完成", tone: "success" },
  warning: { label: "异常", tone: "warning" },
  error: { label: "异常", tone: "error" },
};

export const dotStatusLabels: Record<DotStatus, string> = {
  pending: "待分析",
  queued: "待核价",
  running: "处理中",
  pricing: "核价中",
  ready: "待确认",
  success: "完成",
  warning: "警告",
  error: "异常",
};

export const fileTabs: Array<{ key: FileTab; label: string }> = [
  { key: "pending", label: "待分析" },
  { key: "queued", label: "待核价" },
  { key: "confirm", label: "待确认" },
  { key: "error", label: "异常" },
  { key: "success", label: "完成" },
];

export const MAX_INPUT_FILES = 5_000;
export const RESULT_REVEAL_HIGHLIGHT_MS = 1_800;
export const DETAIL_CONTENT_DEFER_FRAMES = 2;
