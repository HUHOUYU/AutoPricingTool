import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { type Column, type ColumnDef, type ColumnPinningState, type ColumnSizingState, type SortingState, type VisibilityState, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  BarChart3,
  CircleHelp,
  CircleStop,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  ExternalLink,
  FileBox,
  FileCheck2,
  FileClock,
  FileCog,
  FilePlus2,
  FileSpreadsheet,
  FileUp,
  FolderOpen,
  FolderOutput,
  LayoutDashboard,
  Inbox,
  LoaderCircle,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  ScanSearch,
  Settings,
  Settings2,
  SlidersHorizontal,
  Square,
  Sun,
  Trash2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import brandExcelUrl from "@/assets/brand-excel.png";
import { useDropzone, type DropEvent } from "react-dropzone";
import { toast, Toaster } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProgressChart } from "@/components/progress-chart";
import { ConfigCenterPage } from "@/components/config-center-page";
import { DashboardPage } from "@/components/dashboard-page";
import { AnalyticsPage } from "@/components/analytics-page";
import { LogCenterPage } from "@/components/log-center-page";
import { TemplateManagementPage } from "@/components/template-management-page";
import { ExcelPreview, type ExcelPreviewCandidate } from "@/components/excel-preview";
import { MappingEditor, type MappingFieldTarget, type MappingValidationState } from "@/components/mapping-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IssueDetailsDialog, type IssueDetail } from "@/components/ui/issue-details-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useUIStore, type FileTab, type WorkbenchPage } from "@/stores/ui-store";
import type { ExcelPreviewWorkbook } from "@/lib/excel-preview";
import type {
  AppPreferences,
  AppState,
  ConfigDocument,
  DesktopAPI,
  PriceAnalysisCandidate,
  PriceAnalysisFile,
  PriceCheckMapping,
  PricePreviewCellEdit,
  PricePreviewWritebackRow,
  PriceUnmatchedIssue,
  ProcessorEvent,
  TaskExecutionType,
  TaskIssueSummary,
} from "../../preload";
import { classifyTaskIssue, TASK_ISSUE_LABELS } from "../../shared/task-history";

gsap.registerPlugin(useGSAP);

type FileResult = {
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

type ImportMode = "file" | "folder" | "config";
type ImportSourceMode = Exclude<ImportMode, "config">;

type ImportSummary = {
  imported: number;
  duplicates: number;
};

type RegisterPathsOptions = {
  replaceBatch?: boolean;
};

type AnalyzeFilesOptions = {
  preserveExisting?: boolean;
};

type LogEntry = {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
};

type FileStatus = "pending" | "running" | "ready" | "success" | "warning" | "error";
type DotStatus = FileStatus;
type IssueReviewTab = Extract<FileTab, "confirm" | "error">;

type ManualIssueReviewContext = {
  path: string;
  preferredTab: IssueReviewTab;
  phase: "analysis" | "run";
  outcome?: "completed" | "failed";
};

type ManualIssueReviewResolution = {
  path: string;
  preferredTab: IssueReviewTab;
  outcome: "completed" | "failed" | "unresolved";
};

type ProgressDot = {
  path: string;
  status: DotStatus;
  label: string;
};

const statusMeta: Record<FileStatus, { label: string; tone: FileStatus }> = {
  pending: { label: "待分析", tone: "pending" },
  running: { label: "处理中", tone: "running" },
  ready: { label: "待确认", tone: "ready" },
  success: { label: "完成", tone: "success" },
  warning: { label: "异常", tone: "warning" },
  error: { label: "异常", tone: "error" },
};

const dotStatusLabels: Record<DotStatus, string> = {
  pending: "待分析",
  running: "处理中",
  ready: "待确认",
  success: "完成",
  warning: "警告",
  error: "异常",
};

const fileTabs: Array<{ key: FileTab; label: string }> = [
  { key: "pending", label: "待分析" },
  { key: "confirm", label: "待确认" },
  { key: "error", label: "异常" },
  { key: "success", label: "完成" },
];

const navigationItems: Array<{ key: WorkbenchPage; label: string; icon: LucideIcon }> = [
  { key: "workbench", label: "工作台", icon: LayoutDashboard },
  { key: "files", label: "文件处理", icon: FileCheck2 },
  { key: "templates", label: "模板管理", icon: FileCog },
  { key: "config", label: "配置中心", icon: Settings2 },
  { key: "rules", label: "规则管理", icon: Workflow },
  { key: "logs", label: "日志中心", icon: FileClock },
  { key: "analytics", label: "数据统计", icon: BarChart3 },
];

const MAX_INPUT_FILES = 5_000;
const TASK_ISSUE_SAMPLE_LIMIT = 20;
const DETAIL_DRAWER_DEFAULT_RATIO = 0.9;
const DETAIL_DRAWER_MIN_WIDTH = 760;
const DETAIL_DRAWER_EDGE_GAP = 72;
const DETAIL_DRAWER_KEYBOARD_STEP = 24;
const DETAIL_SIDEBAR_DEFAULT_WIDTH = 360;
const DETAIL_SIDEBAR_MIN_WIDTH = 280;
const DETAIL_SIDEBAR_MAX_WIDTH = 520;
const DETAIL_SIDEBAR_KEYBOARD_STEP = 16;
const DETAIL_PREVIEW_MIN_WIDTH = 360;
const DETAIL_CONTENT_HORIZONTAL_PADDING = 28;
const DETAIL_CONTENT_RESIZER_WIDTH = 12;
const RESULT_REVEAL_HIGHLIGHT_MS = 1_800;
const DETAIL_CONTENT_DEFER_FRAMES = 2;

function detailDrawerBounds(viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth): { min: number; max: number } {
  const max = Math.max(320, viewportWidth - DETAIL_DRAWER_EDGE_GAP);
  return { min: Math.min(DETAIL_DRAWER_MIN_WIDTH, max), max };
}

function clampDetailDrawerWidth(width: number): number {
  const bounds = detailDrawerBounds();
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function defaultDetailDrawerWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  return clampDetailDrawerWidth(Math.round(viewportWidth * DETAIL_DRAWER_DEFAULT_RATIO));
}

function detailSidebarBounds(drawerWidth: number): { min: number; max: number } {
  const availableMax = drawerWidth - DETAIL_CONTENT_HORIZONTAL_PADDING - DETAIL_CONTENT_RESIZER_WIDTH - DETAIL_PREVIEW_MIN_WIDTH;
  return { min: DETAIL_SIDEBAR_MIN_WIDTH, max: Math.max(DETAIL_SIDEBAR_MIN_WIDTH, Math.min(DETAIL_SIDEBAR_MAX_WIDTH, availableMax)) };
}

function clampDetailSidebarWidth(width: number, drawerWidth: number): number {
  const bounds = detailSidebarBounds(drawerWidth);
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function getDesktopAPI(): DesktopAPI | null {
  return window.desktopAPI ?? null;
}

function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function isExcelPath(path: string): boolean {
  return /\.(xlsx|xlsm|xlsb|xls)$/i.test(path);
}

function isExcelFile(file: File): boolean {
  return isExcelPath(file.name);
}

function getNativeFilesFromEvent(event: DropEvent): Promise<File[]> {
  if ("dataTransfer" in event && event.dataTransfer?.files) {
    return Promise.resolve(Array.from(event.dataTransfer.files));
  }
  if ("target" in event && event.target && "files" in event.target) {
    const files = (event.target as HTMLInputElement).files;
    return Promise.resolve(files ? Array.from(files) : []);
  }
  return Promise.resolve([]);
}

function droppedFolderName(file: File): string | null {
  const relativePath = file.webkitRelativePath || (file as File & { path?: string }).path || "";
  const parts = relativePath.replace(/^[\\/]+/, "").split(/[\\/]/).filter((part) => Boolean(part) && part !== ".");
  return parts.length > 1 ? parts[0] : null;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function defaultDraftBatchName(paths: string[], mode: ImportMode): string {
  if (paths.length === 0) return "";
  if (mode === "folder") return fileNameFromPath(parentDirectory(paths[0])) || "文件夹批次";
  if (paths.length === 1) return fileNameFromPath(paths[0]);
  return `${fileNameFromPath(paths[0])} 等 ${paths.length} 个文件`;
}

function normalizeAlternativeOrderColumns(mapping: PriceCheckMapping): PriceCheckMapping {
  const countryEnglishColumn = mapping.countryEnglishColumn === mapping.countryCodeColumn
    ? null
    : mapping.countryEnglishColumn;
  const countryChineseColumn = mapping.countryChineseColumn === mapping.countryCodeColumn
    || mapping.countryChineseColumn === countryEnglishColumn
    ? null
    : mapping.countryChineseColumn;
  return { ...mapping, countryEnglishColumn, countryChineseColumn };
}

function buildMapping(order: PriceAnalysisCandidate, pricing: PriceAnalysisCandidate): PriceCheckMapping {
  return normalizeAlternativeOrderColumns({
    orderSheet: order.sheetName,
    orderHeaderRow: order.headerRow,
    businessOrderNumberColumn: order.businessOrderNumberColumn ?? null,
    countryCodeColumn: order.countryCodeColumn ?? null,
    countryEnglishColumn: order.countryEnglishColumn ?? null,
    countryChineseColumn: order.countryChineseColumn ?? null,
    skuQtyPairs: order.skuQtyPairs ?? [],
    singleShipmentColumn: order.singleShipmentColumn ?? null,
    singleShipmentFields: order.singleShipmentFields ?? [],
    orderPriceColumn: order.priceColumn ?? null,
    pricingSheet: pricing.sheetName,
    pricingHeaderRow: pricing.headerRow,
    pricingQuantityHeaderRow: pricing.quantityHeaderRow ?? null,
    pricingSkuColumn: pricing.skuColumn ?? 1,
    pricingCountryColumn: pricing.countryColumn ?? 1,
    quantityTierColumns: pricing.tierColumns ?? [],
  });
}

function formatCoverage(value: number | undefined): string {
  return String(((value ?? 0) * 100).toFixed(1)) + "%";
}

function DecisionMappingText({ value }: { value: string }): React.JSX.Element {
  const mappingPairs = value.split("、").map((pair) => /^(SKU\s+[A-Z]+(?:（[^）]*）|\([^)]*\))?)\s*\/\s*(数量\s+[A-Z]+(?:（[^）]*）|\([^)]*\))?)$/.exec(pair.trim()));
  if (mappingPairs.every((pair) => pair !== null)) {
    return (
      <span className="decision-reason-value is-paired">
        {mappingPairs.map((pair, index) => <span className="decision-mapping-pair" key={`${pair[1]}-${pair[2]}-${index}`}><em className="decision-mapping-token is-sku">{pair[1]}</em><em className="decision-mapping-token is-quantity">{pair[2]}</em></span>)}
      </span>
    );
  }
  const parts = value.split(/((?:SKU|数量)\s+[A-Z]+(?:（[^）]*）|\([^)]*\))?)/g).filter(Boolean);
  return (
    <span className="decision-reason-value is-inline">
      {parts.map((part, index) => {
        const tone = part.startsWith("SKU ") ? "is-sku" : part.startsWith("数量 ") ? "is-quantity" : "";
        return tone ? <em className={`decision-mapping-token ${tone}`} key={`${part}-${index}`}>{part}</em> : <span key={`${part}-${index}`}>{part}</span>;
      })}
    </span>
  );
}

function DecisionReason({
  reason,
  bestScore,
  runnerUpScore,
  scoreKind,
  quantityIssues,
  unmatchedIssues,
  onOpenUnmatchedDetails,
}: {
  reason: string;
  bestScore?: number | null;
  runnerUpScore?: number | null;
  scoreKind?: "field" | "sheet" | null;
  quantityIssues: PricePreviewWritebackRow[];
  unmatchedIssues: PriceUnmatchedIssue[];
  onOpenUnmatchedDetails: (summary: string) => void;
}): React.JSX.Element {
  const comparison = /^(.*?)(?:：|:)\s*最优\s*\[(.*?)\]\s*[；;]\s*次优\s*\[(.*?)\]\s*$/.exec(reason);
  if (!comparison) {
    return (
      <li className="decision-reason is-plain">
        <ValidationMessage
          message={reason}
          quantityIssues={quantityIssues}
          unmatchedIssues={unmatchedIssues}
          onOpenUnmatchedDetails={onOpenUnmatchedDetails}
        />
      </li>
    );
  }
  const score = (value: number | null | undefined): React.JSX.Element | null => value == null ? null : <small>{scoreKind === "sheet" ? "Sheet" : "字段"} {value.toFixed(1)} 分</small>;
  return (
    <li className="decision-reason is-comparison">
      <p>{comparison[1]}</p>
      <div className="decision-candidate is-best"><span><b>最优</b>{score(bestScore)}</span><DecisionMappingText value={comparison[2]} /></div>
      <div className="decision-candidate is-alternate"><span><b>次选</b>{score(runnerUpScore)}</span><DecisionMappingText value={comparison[3]} /></div>
    </li>
  );
}

function ValidationMessage({
  message,
  quantityIssues,
  unmatchedIssues,
  onOpenUnmatchedDetails,
}: {
  message: string;
  quantityIssues: PricePreviewWritebackRow[];
  unmatchedIssues: PriceUnmatchedIssue[];
  onOpenUnmatchedDetails: (summary: string) => void;
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasQuantityDetails = message.includes("数量无法计算") && quantityIssues.length > 0;
  const hasUnmatchedDetails = (
    message.includes("覆盖率")
    || message.includes("试算少于")
  ) && unmatchedIssues.length > 0;
  const hasDetails = hasQuantityDetails || hasUnmatchedDetails;
  const detailIssues = useMemo(
    () => dialogOpen && hasQuantityDetails ? quantityIssueDetails(quantityIssues) : [],
    [dialogOpen, hasQuantityDetails, quantityIssues],
  );
  return (
    <div className="issue-status-message-row">
      <span>{message}</span>
      {hasDetails ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={hasQuantityDetails ? dialogOpen : undefined}
          aria-label={hasQuantityDetails ? "查看数量异常详情" : "查看未匹配详情"}
          onClick={() => {
            if (hasQuantityDetails) {
              setDialogOpen(true);
            } else {
              onOpenUnmatchedDetails(message);
            }
          }}
        >
          详情
        </button>
      ) : null}
      <IssueDetailsDialog
        open={dialogOpen && hasQuantityDetails}
        title="数量计算问题"
        summary={message}
        issues={detailIssues}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

function quantityIssueDetails(quantityIssues: PricePreviewWritebackRow[]): IssueDetail[] {
  return quantityIssues.map((issue) => ({
    sourceRow: issue.sourceRow,
    label: `第 ${issue.sourceRow} 行`,
    message: quantityIssueMessage(issue.quantityError),
    skuTags: issue.quantityIssueContext ? [
      {
        role: "previous" as const,
        label: `${excelColumnLetter(issue.quantityIssueContext.previousSkuColumn)} 列`,
        value: issue.quantityIssueContext.previousSku,
      },
      {
        role: "main" as const,
        label: `${excelColumnLetter(issue.quantityIssueContext.mainSkuColumn)} 列`,
        value: issue.quantityIssueContext.mainSku,
      },
    ] : undefined,
  }));
}

function unmatchedIssueDetails(unmatchedIssues: PriceUnmatchedIssue[]): IssueDetail[] {
  return unmatchedIssues.map((issue) => {
    const reasonSeparator = issue.reason.indexOf("：");
    const reasonType = reasonSeparator >= 0 ? issue.reason.slice(0, reasonSeparator) : "价格未匹配";
    const reasonDetail = reasonSeparator >= 0 ? issue.reason.slice(reasonSeparator + 1) : issue.reason;
    const pricingSheet = /核价 Sheet (.+?) 中/u.exec(reasonDetail)?.[1]?.trim();
    return {
      sourceRow: issue.sourceRow,
      label: `第 ${issue.sourceRow} 行`,
      message: reasonDetail,
      emphasis: [
        { label: "类型", value: reasonType, tone: "danger" as const },
        { label: "国家", value: issue.country || "缺失", tone: "warning" as const },
        { label: "数量", value: String(issue.quantity), tone: "info" as const },
      ],
      messageHighlights: [
        ...(pricingSheet ? [{ value: pricingSheet, tone: "info" as const }] : []),
        ...issue.country.split("/").map((value) => value.trim()).filter(Boolean)
          .map((value) => ({ value, tone: "warning" as const })),
        ...(issue.sku ? [{ value: issue.sku, tone: "info" as const }] : []),
        { value: String(issue.quantity), tone: "info" as const },
      ],
      skuTags: issue.sku ? [{
        role: "main" as const,
        label: issue.skuColumn > 0 ? `${excelColumnLetter(issue.skuColumn)} 列` : "SKU",
        value: issue.sku,
      }] : undefined,
    };
  });
}

function taskIssueSummaries(
  unmatchedIssues: PriceUnmatchedIssue[],
  quantityIssues: PricePreviewWritebackRow[],
): TaskIssueSummary[] {
  const summaries = new Map<TaskIssueSummary["code"], TaskIssueSummary>();
  const addIssue = (
    reason: string,
    sample: TaskIssueSummary["samples"][number],
  ): void => {
    const code = classifyTaskIssue(reason);
    const current = summaries.get(code) ?? {
      code,
      label: TASK_ISSUE_LABELS[code],
      count: 0,
      samples: [],
    };
    current.count += 1;
    if (current.samples.length < TASK_ISSUE_SAMPLE_LIMIT) current.samples.push(sample);
    summaries.set(code, current);
  };
  for (const issue of unmatchedIssues) {
    addIssue(issue.reason, {
      sourceRow: issue.sourceRow,
      country: issue.country,
      sku: issue.sku,
      quantity: issue.quantity,
      reason: issue.reason,
    });
  }
  for (const issue of quantityIssues) {
    if (!issue.quantityError) continue;
    addIssue(issue.quantityError, {
      sourceRow: issue.sourceRow,
      country: "",
      sku: issue.quantityIssueContext?.mainSku ?? "",
      quantity: issue.quantity,
      reason: issue.quantityError,
    });
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count);
}

function isAnalysisError(analysis: PriceAnalysisFile | undefined): boolean {
  if (!analysis) return false;
  return (
    analysis.orderSheetCandidates.length === 0 ||
    analysis.pricingSheetCandidates.length === 0 ||
    analysis.issues.some((issue) => issue.startsWith("读取失败") || issue.startsWith("未识别到"))
  );
}

function tabForStatus(status: FileStatus): FileTab {
  if (status === "pending" || status === "running") return "pending";
  if (status === "success") return "success";
  if (status === "warning" || status === "error") return "error";
  return "confirm";
}

/** 批处理结束后优先落到有结果的 Tab */
function pickBestResultTab(counts: Record<FileTab, number>): FileTab | null {
  if (counts.confirm > 0) return "confirm";
  if (counts.error > 0) return "error";
  if (counts.success > 0) return "success";
  if (counts.pending > 0) return "pending";
  return null;
}

function columnLabel(value: number | null | undefined): string {
  return value ? "第 " + value + " 列" : "未识别";
}

function excelColumnLetter(column: number): string {
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label || "?";
}

function quantityIssueMessage(error: string | null | undefined): string {
  if (!error) return "数量无法计算";
  if (error.includes("无共同组件")) return "两个 SKU 没有共同组件，无法换算数量";
  if (error.includes("组件比例冲突")) return "共同组件的倍数比例冲突，无法确定数量";
  return error;
}

function statusForFile(
  path: string,
  analysis: PriceAnalysisFile | undefined,
  result: FileResult | undefined,
  activePath: string,
  isBusy: boolean,
  manuallyConfirmed: boolean,
): FileStatus {
  if (result?.status === "failed") return "error";
  if (result?.status === "completed") return manuallyConfirmed || (result.exceptionRows ?? 0) === 0 ? "success" : "warning";
  if (isBusy && activePath === path) return "running";
  if (analysis) return isAnalysisError(analysis) || analysis.automationDecision.status === "error" ? "error" : "ready";
  return "pending";
}

type IconActionProps = {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: "normal" | "primary" | "danger";
  compact?: boolean;
};

function IconAction({ icon: Icon, label, onClick, disabled = false, active = false, tone = "normal", compact = false }: IconActionProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={tone === "primary" || active ? "default" : "outline"}
      size={compact ? "icon" : "default"}
      className={["icon-action", active ? "is-active" : "", tone !== "normal" ? "is-" + tone : "", compact ? "is-compact" : ""].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
      <span>{label}</span>
    </Button>
  );
}

function mappingIsComplete(mapping: PriceCheckMapping | null | undefined): boolean {
  return Boolean(
    mapping &&
    mapping.businessOrderNumberColumn &&
    (mapping.countryCodeColumn || mapping.countryEnglishColumn || mapping.countryChineseColumn) &&
    mapping.skuQtyPairs.length > 0 &&
    mapping.skuQtyPairs.every((pair) => (
      pair.qtyColumn > 0
      && pair.skuColumn > 0
      && pair.mergedQtyColumn > 0
      // 顺序：原始数量 → SKU → 合并数量；中间可夹其他列
      && pair.qtyColumn < pair.skuColumn
      && pair.skuColumn < pair.mergedQtyColumn
    )) &&
    mapping.pricingSkuColumn > 0 &&
    mapping.pricingCountryColumn > 0 &&
    mapping.quantityTierColumns.length > 0 &&
    mapping.orderSheet !== mapping.pricingSheet,
  );
}

function applyMappingColumn(mapping: PriceCheckMapping, target: MappingFieldTarget, column: number | null, header: string): PriceCheckMapping {
  const pairMatch = /^skuQtyPairs\.(\d+)\.(skuColumn|qtyColumn|mergedQtyColumn)$/.exec(target);
  if (pairMatch) {
    const pairIndex = Number(pairMatch[1]);
    const field = pairMatch[2] as "skuColumn" | "qtyColumn" | "mergedQtyColumn";
    const headerField = field === "skuColumn"
      ? "skuHeader"
      : field === "qtyColumn"
        ? "qtyHeader"
        : "mergedQtyHeader";
    return {
      ...mapping,
      skuQtyPairs: mapping.skuQtyPairs.map((pair, index) => index === pairIndex ? { ...pair, [field]: column ?? 0, [headerField]: header } : pair),
    };
  }
  const tierMatch = /^quantityTierColumns\.(\d+)\.column$/.exec(target);
  if (tierMatch) {
    const tierIndex = Number(tierMatch[1]);
    return {
      ...mapping,
      quantityTierColumns: mapping.quantityTierColumns.map((tier, index) => index === tierIndex ? { ...tier, column: column ?? 0, header } : tier),
    };
  }
  const singleShipmentMatch = /^singleShipmentFields\.(\d+)\.column$/.exec(target);
  if (singleShipmentMatch) {
    const fieldIndex = Number(singleShipmentMatch[1]);
    const singleShipmentFields = (mapping.singleShipmentFields ?? []).map((field, index) =>
      index === fieldIndex
        ? {
            ...field,
            columns: column ? [column] : [],
            headers: column ? [header] : [],
          }
        : field,
    );
    const editedField = singleShipmentFields[fieldIndex];
    return {
      ...mapping,
      singleShipmentFields,
      singleShipmentColumn: editedField?.field === "recipient_name"
        ? column
        : mapping.singleShipmentColumn,
    };
  }
  if (target.endsWith("HeaderRow")) return mapping;
  if (target === "pricingSkuColumn" || target === "pricingCountryColumn") return { ...mapping, [target]: column ?? 0 };
  return { ...mapping, [target]: column };
}

function mappingTargetLabel(target: MappingFieldTarget | null): string {
  if (!target) return "";
  const labels: Partial<Record<MappingFieldTarget, string>> = {
    orderHeaderRow: "订单表头行",
    businessOrderNumberColumn: "订单号",
    countryCodeColumn: "国家二字码",
    countryEnglishColumn: "英文国家名",
    countryChineseColumn: "中文国家名",
    singleShipmentColumn: "单独发货字段",
    orderPriceColumn: "原始价格",
    pricingHeaderRow: "核价表头行",
    pricingQuantityHeaderRow: "数量档位表头行",
    pricingSkuColumn: "核价 SKU",
    pricingCountryColumn: "核价国家",
  };
  if (labels[target]) return labels[target];
  const singleShipment = /^singleShipmentFields\.(\d+)\.column$/.exec(target);
  if (singleShipment) {
    return `单独发货联合字段 ${Number(singleShipment[1]) + 1}`;
  }
  const pair = /^skuQtyPairs\.(\d+)\.(skuColumn|qtyColumn|mergedQtyColumn)$/.exec(target);
  if (pair) {
    const label = pair[2] === "skuColumn"
      ? "SKU"
      : pair[2] === "qtyColumn"
        ? "原始数量"
        : "合并数量";
    return `${label} ${Number(pair[1]) + 1}`;
  }
  const tier = /^quantityTierColumns\.(\d+)\.column$/.exec(target);
  return tier ? `价格列 ${Number(tier[1]) + 1}` : "字段";
}

function mappingColumnConflict(mapping: PriceCheckMapping, target: MappingFieldTarget, column: number): string | null {
  const pricingTarget = target.startsWith("pricing") || target.startsWith("quantityTierColumns");
  const singleShipmentEntries: Array<[MappingFieldTarget, number]> = (
    mapping.singleShipmentFields?.length
      ? mapping.singleShipmentFields.flatMap((field, index) =>
          field.columns.map((fieldColumn) => [
            `singleShipmentFields.${index}.column` as MappingFieldTarget,
            fieldColumn,
          ] as [MappingFieldTarget, number]),
        )
      : mapping.singleShipmentColumn
        ? [["singleShipmentColumn", mapping.singleShipmentColumn]]
        : []
  );
  const entries: Array<[MappingFieldTarget, number | null | undefined]> = pricingTarget
    ? [
        ["pricingSkuColumn", mapping.pricingSkuColumn],
        ["pricingCountryColumn", mapping.pricingCountryColumn],
        ...mapping.quantityTierColumns.map((tier, index) => [`quantityTierColumns.${index}.column` as MappingFieldTarget, tier.column] as [MappingFieldTarget, number]),
      ]
    : [
        ["businessOrderNumberColumn", mapping.businessOrderNumberColumn],
        ["countryCodeColumn", mapping.countryCodeColumn],
        ["countryEnglishColumn", mapping.countryEnglishColumn],
        ["countryChineseColumn", mapping.countryChineseColumn],
        ...singleShipmentEntries,
        ["orderPriceColumn", mapping.orderPriceColumn],
        ...mapping.skuQtyPairs.flatMap((pair, index) => [
          [`skuQtyPairs.${index}.skuColumn` as MappingFieldTarget, pair.skuColumn] as [MappingFieldTarget, number],
          [`skuQtyPairs.${index}.qtyColumn` as MappingFieldTarget, pair.qtyColumn] as [MappingFieldTarget, number],
          [`skuQtyPairs.${index}.mergedQtyColumn` as MappingFieldTarget, pair.mergedQtyColumn] as [MappingFieldTarget, number],
        ]),
      ];
  const conflict = entries.find(([entryTarget, entryColumn]) => entryTarget !== target && entryColumn === column);
  return conflict ? mappingTargetLabel(conflict[0]) : null;
}

function SidebarTooltip({ label, enabled, children }: { label: string; enabled: boolean; children: React.JSX.Element }): React.JSX.Element {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} collisionPadding={8} className="cyber-rail-tooltip">{label}</TooltipContent>
    </Tooltip>
  );
}

export function App(): React.JSX.Element {
  const shellRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, PriceAnalysisFile>>({});
  const [mappings, setMappings] = useState<Record<string, PriceCheckMapping>>({});
  const [results, setResults] = useState<Record<string, FileResult>>({});
  const [inputDir, setInputDir] = useState("");
  const [inputDirectorySelected, setInputDirectorySelected] = useState(false);
  const [importSourceMode, setImportSourceMode] = useState<ImportSourceMode>("file");
  const [outputDir, setOutputDir] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [autoRevealManualResult, setAutoRevealManualResult] = useState(false);
  const [continuousIssueReviewEnabled, setContinuousIssueReviewEnabled] = useState(false);
  const [pendingResultRevealPath, setPendingResultRevealPath] = useState<string | null>(null);
  const [highlightedResultPath, setHighlightedResultPath] = useState<string | null>(null);
  const [manualIssueReviewResolution, setManualIssueReviewResolution] = useState<ManualIssueReviewResolution | null>(null);
  const { activeTab, setActiveTab, activePage, setActivePage, theme, toggleTheme, sidebarCollapsed, toggleSidebar } = useUIStore();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [batchStarted, setBatchStarted] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchName, setBatchName] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [editingBatchName, setEditingBatchName] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [pinnedFileColumns, setPinnedFileColumns] = useState<Record<FileTab, string[]>>({ pending: [], confirm: [], error: [], success: [] });
  const [importedAt, setImportedAt] = useState<Record<string, string>>({});
  const [importModes, setImportModes] = useState<Record<string, ImportMode>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [activePath, setActivePath] = useState("");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: "", path: "" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [requestedHistoryBatchId, setRequestedHistoryBatchId] = useState<string | null>(null);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailContentReady, setDetailContentReady] = useState(false);
  const [detailPreviewSheetName, setDetailPreviewSheetName] = useState("");
  const [detailPreviewWorkbook, setDetailPreviewWorkbook] = useState<ExcelPreviewWorkbook | null>(null);
  const [issueDetailsRequest, setIssueDetailsRequest] = useState<{
    kind: "quantity" | "unmatched";
    sourceRow: number | null;
    summary: string;
  } | null>(null);
  const [activeMappingTarget, setActiveMappingTarget] = useState<MappingFieldTarget | null>(null);
  const [mappingValidations, setMappingValidations] = useState<Record<string, MappingValidationState>>({});
  const [matchedOrderRowsBySheet, setMatchedOrderRowsBySheet] = useState<Record<string, Record<string, number[]>>>({});
  const [writebackEdits, setWritebackEdits] = useState<Record<string, PricePreviewWritebackRow[]>>({});
  const [cellEdits, setCellEdits] = useState<Record<string, PricePreviewCellEdit[]>>({});
  const [detailDrawerWidth, setDetailDrawerWidth] = useState(defaultDetailDrawerWidth);
  const [detailSidebarWidth, setDetailSidebarWidth] = useState(DETAIL_SIDEBAR_DEFAULT_WIDTH);
  const [detailDrawerViewportWidth, setDetailDrawerViewportWidth] = useState(() => window.innerWidth);
  const [analysisCompletedToken, setAnalysisCompletedToken] = useState(0);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [nextBatchConfirmOpen, setNextBatchConfirmOpen] = useState(false);
  const detailDrawerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const detailSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const detailDrawerCustomWidthRef = useRef(false);
  const detailDrawerWidthRef = useRef(detailDrawerWidth);
  const analysesRef = useRef<Record<string, PriceAnalysisFile>>({});
  const resultsRef = useRef<Record<string, FileResult>>({});
  const mappingsRef = useRef<Record<string, PriceCheckMapping>>({});
  const writebackEditsRef = useRef<Record<string, PricePreviewWritebackRow[]>>({});
  const cellEditsRef = useRef<Record<string, PricePreviewCellEdit[]>>({});
  const confirmedPathsRef = useRef<Set<string>>(new Set());
  const resultRevealHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRunRequestedRef = useRef(false);
  const autoRunTargetPathsRef = useRef<string[]>([]);
  const manualIssueReviewRef = useRef<ManualIssueReviewContext | null>(null);
  const userTabLockedRef = useRef(false);
  const batchTaskWasActiveRef = useRef(false);
  const batchIdRef = useRef<string | null>(null);
  const batchNameEditedRef = useRef(false);
  const mappingValidationVersionsRef = useRef<Record<string, number>>({});
  const priceRowValidationVersionsRef = useRef<Record<string, number>>({});
  const mappingValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mappingValidationInFlightRef = useRef(false);
  const activeMappingValidationRef = useRef<{ path: string; mapping: PriceCheckMapping; version: number } | null>(null);
  const pendingMappingValidationRef = useRef<{ path: string; mapping: PriceCheckMapping; version: number } | null>(null);
  const batchLayout = activePage !== "files" ? null : batchStarted ? "locked" : files.length > 0 ? "ready" : "empty";
  const previousBatchLayoutRef = useRef<typeof batchLayout>(null);

  useEffect(() => {
    setIssueDetailsRequest(null);
  }, [detailPath]);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    if (continuousIssueReviewEnabled) return;
    manualIssueReviewRef.current = null;
    setManualIssueReviewResolution(null);
  }, [continuousIssueReviewEnabled]);

  useEffect(() => {
    setDetailContentReady(false);
    if (!detailPath) return;
    const frameIds: number[] = [];
    const deferFrame = (remainingFrames: number): void => {
      frameIds.push(window.requestAnimationFrame(() => {
        if (remainingFrames > 1) {
          deferFrame(remainingFrames - 1);
        } else {
          setDetailContentReady(true);
        }
      }));
    };
    deferFrame(DETAIL_CONTENT_DEFER_FRAMES);
    return () => frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
  }, [detailPath]);

  useGSAP(() => {
    const workspace = workspaceRef.current;
    const previousLayout = previousBatchLayoutRef.current;
    previousBatchLayoutRef.current = batchLayout;
    if (!workspace || !batchLayout) return;

    if (batchLayout === "locked") {
      gsap.set(workspace, { clearProps: "gridTemplateRows" });
      return;
    }

    const finalRows = batchLayout === "empty" ? "calc(100% - 116px) 108px" : "56px calc(100% - 64px)";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.userAgent.includes("jsdom");
    if (!previousLayout || previousLayout === batchLayout || reducedMotion) {
      gsap.set(workspace, { clearProps: "gridTemplateRows" });
      return;
    }

    const workspaceHeight = workspace.clientHeight;
    const emptyRows = `${Math.max(0, workspaceHeight - 116)}px 108px`;
    const readyRows = `56px ${Math.max(0, workspaceHeight - 64)}px`;
    const lockedRows = `0px ${workspaceHeight}px`;
    const timeline = gsap.timeline({
      onComplete: () => gsap.set(workspace, { clearProps: "gridTemplateRows" }),
    });

    timeline.fromTo(workspace, {
      gridTemplateRows: previousLayout === "empty" ? emptyRows : previousLayout === "ready" ? readyRows : lockedRows,
    }, {
      gridTemplateRows: finalRows,
      duration: 1,
      ease: "power3.inOut",
    }, 0);

    if (batchLayout === "ready") {
      timeline.fromTo(".cyber-file-table tbody", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.42, ease: "power2.out" }, 0.5);
      timeline.fromTo(".cyber-pagination", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.58);
    } else {
      timeline.fromTo(".cyber-upload-panel", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, ease: "power2.out" }, 0.08);
      timeline.fromTo(".cyber-dropzone", { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.52, ease: "power2.out" }, 0.18);
    }
  }, { scope: workspaceRef, dependencies: [batchLayout], revertOnUpdate: true });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const handleWindowResize = (): void => {
      setDetailDrawerViewportWidth(window.innerWidth);
      setDetailDrawerWidth((current) => detailDrawerCustomWidthRef.current ? clampDetailDrawerWidth(current) : defaultDetailDrawerWidth());
    };
    const handlePointerMove = (event: PointerEvent): void => {
      const drawerResize = detailDrawerResizeRef.current;
      if (drawerResize) setDetailDrawerWidth(clampDetailDrawerWidth(drawerResize.startWidth + drawerResize.startX - event.clientX));
      const sidebarResize = detailSidebarResizeRef.current;
      if (sidebarResize) setDetailSidebarWidth(clampDetailSidebarWidth(sidebarResize.startWidth + sidebarResize.startX - event.clientX, detailDrawerWidthRef.current));
    };
    const handlePointerUp = (): void => {
      detailDrawerResizeRef.current = null;
      detailSidebarResizeRef.current = null;
    };
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    detailDrawerWidthRef.current = detailDrawerWidth;
    setDetailSidebarWidth((current) => clampDetailSidebarWidth(current, detailDrawerWidth));
  }, [detailDrawerWidth]);

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

  const sendMappingValidation = useCallback((path: string, mapping: PriceCheckMapping, version: number): void => {
    if (mappingValidationInFlightRef.current) {
      pendingMappingValidationRef.current = { path, mapping, version };
      setMappingValidations((current) => ({ ...current, [path]: { status: "validating", result: current[path]?.result ?? null } }));
      return;
    }
    const api = getDesktopAPI();
    if (!api) return;
    mappingValidationInFlightRef.current = true;
    activeMappingValidationRef.current = { path, mapping, version };
    setMappingValidations((current) => ({ ...current, [path]: { status: "validating", result: current[path]?.result ?? null } }));
    void api.validatePriceMapping({
      inputPath: path,
      mapping,
      requestVersion: version,
      cellEdits: cellEditsRef.current[path] ?? [],
      configPath: configPath || undefined,
    }).catch((error: unknown) => {
      mappingValidationInFlightRef.current = false;
      activeMappingValidationRef.current = null;
      setMappingValidations((current) => ({
        ...current,
        [path]: {
          status: "ready",
          result: { inputPath: path, requestVersion: version, evaluatedRows: 0, matchedRows: 0, coverage: 0, errors: ["试算请求失败：" + String(error)], warnings: [] },
        },
      }));
    });
  }, [configPath]);

  useEffect(() => {
    const api = getDesktopAPI();
    if (!api) {
      appendLog("Electron 接口未加载，请从桌面应用启动", "error");
      return undefined;
    }
    let active = true;
    void Promise.all([api.getAppPreferences(), api.getAppState()])
      .then(([preferences, state]) => {
        if (!active) return;
        setInputDir(state.recentInputDirectory);
        setOutputDir(state.recentOutputDirectory);
        setConfigPath(state.activeBusinessConfigPath);
        setAutoRevealManualResult(preferences.autoRevealManualResult);
        setContinuousIssueReviewEnabled(preferences.continuousIssueReviewEnabled);
      })
      .catch((error: unknown) => appendLog("读取应用设置失败：" + String(error), "warning"));
    return () => {
      active = false;
    };
  }, [activePage, appendLog]);

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
    [appendLog, autoRevealManualResult, continuousIssueReviewEnabled, sendMappingValidation, setActiveTab],
  );

  useEffect(() => {
    const api = getDesktopAPI();
    return api?.onProcessorEvent(handleProcessorEvent);
  }, [handleProcessorEvent]);

  const registerPaths = useCallback((paths: string[], mode: ImportMode, options: RegisterPathsOptions = {}): ImportSummary => {
    const replaceBatch = options.replaceBatch === true;
    if (batchStarted && !replaceBatch) {
      toast.info("当前批次已开始，请先完成或结束当前批次");
      return { imported: 0, duplicates: 0 };
    }
    const existingFiles = replaceBatch ? [] : files;
    const existingKeys = new Set(existingFiles.map((path) => path.toLocaleLowerCase()));
    const uniqueIncoming = Array.from(new Map(paths.map((path) => [path.toLocaleLowerCase(), path])).values());
    const newPaths = uniqueIncoming.filter((path) => !existingKeys.has(path.toLocaleLowerCase()));
    const duplicateCount = paths.length - newPaths.length;
    if (newPaths.length === 0) {
      toast.info(duplicateCount > 0 ? `已跳过 ${duplicateCount} 个重复文件` : "没有发现支持的 Excel 文件");
      return { imported: 0, duplicates: duplicateCount };
    }
    const nextFiles = [...existingFiles, ...newPaths];
    if (nextFiles.length > MAX_INPUT_FILES) {
      appendLog(`文件数量超过上限，最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`, "error");
      toast.error(`最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`);
      return { imported: 0, duplicates: duplicateCount };
    }
    const importedTime = new Date().toLocaleString("zh-CN", { hour12: false });
    setFiles(nextFiles);
    if (replaceBatch) {
      batchIdRef.current = null;
      batchNameEditedRef.current = false;
      setBatchId(null);
      setBatchNote("");
    }
    if (replaceBatch || !batchNameEditedRef.current) {
      setBatchName(defaultDraftBatchName(nextFiles, mode));
    }
    setImportedAt((current) => ({ ...current, ...Object.fromEntries(newPaths.map((path) => [path, importedTime])) }));
    setImportModes((current) => ({ ...current, ...Object.fromEntries(newPaths.map((path) => [path, mode])) }));
    setSelectedPaths([]);
    setActiveTab("pending");
    setInputDirectorySelected(mode !== "file");
    setInputDir((current) => current || parentDirectory(newPaths[0]));
    analysesRef.current = {};
    mappingsRef.current = {};
    writebackEditsRef.current = {};
    cellEditsRef.current = {};
    priceRowValidationVersionsRef.current = {};
    setAnalyses({});
    setMappings({});
    setWritebackEdits({});
    setCellEdits({});
    setMappingValidations({});
    setMatchedOrderRowsBySheet({});
    setDetailPreviewWorkbook(null);
    setActiveMappingTarget(null);
    resultsRef.current = {};
    setResults({});
    setExpandedPath(null);
    setDetailPath(null);
    manualIssueReviewRef.current = null;
    setManualIssueReviewResolution(null);
    autoRunTargetPathsRef.current = [];
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    setPageIndex(0);
    setActivePath("");
    if (replaceBatch) {
      setBatchStarted(false);
      setLogs([]);
      userTabLockedRef.current = false;
      batchTaskWasActiveRef.current = false;
    }
    confirmedPathsRef.current = new Set();
    const modeLabel = mode === "file" ? "文件" : mode === "folder" ? "文件夹" : "配置目录";
    appendLog(`${replaceBatch ? "下一批已通过" : "已通过"}${modeLabel}模式加入 ${newPaths.length} 个 Excel 文件`);
    toast.success(`${replaceBatch ? "下一批已导入" : "已导入"} ${newPaths.length} 个 Excel 文件${duplicateCount ? `，跳过 ${duplicateCount} 个重复文件` : ""}`);
    return { imported: newPaths.length, duplicates: duplicateCount };
  }, [appendLog, batchStarted, files, setActiveTab]);

  const ensureOutputDirectory = useCallback(async (): Promise<string | null> => {
    const api = getDesktopAPI();
    if (!api) return null;
    if (outputDir) return outputDir;
    try {
      const configuredOutputDir = (await api.getAppState()).recentOutputDirectory.trim();
      if (configuredOutputDir) {
        setOutputDir(configuredOutputDir);
        return configuredOutputDir;
      }
    } catch {
      // 读取失败时仍允许用户重新选择并修复输出目录配置。
    }
    const selected = await api.selectDirectory("output", true);
    if (!selected) {
      appendLog("未选择输出文件夹，本次导入已取消", "warning");
      toast.warning("请选择输出文件夹后再导入");
      return null;
    }
    setOutputDir(selected);
    appendLog("输出文件夹已保存：" + selected, "success");
    return selected;
  }, [appendLog, outputDir]);

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

  const addFiles = useCallback(async (incoming: File[]): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const supportedFiles = incoming.filter(isExcelFile);
    if (supportedFiles.length === 0) {
      appendLog("没有发现支持的 Excel 文件（xlsx、xlsm、xlsb、xls）", "warning");
      toast.warning("没有发现支持的 Excel 文件");
      return;
    }
    const paths = supportedFiles.map((file) => {
      try {
        return api.getPathForFile(file);
      } catch {
        return "";
      }
    }).filter(Boolean);
    if (paths.length === 0) {
      appendLog("无法读取所选文件的本地路径，请双击选择文件重试", "warning");
      toast.warning("无法读取文件路径，请双击选择文件重试");
      return;
    }
    if (!await ensureOutputDirectory()) return;
    registerPaths(paths, "file");
  }, [appendLog, ensureOutputDirectory, registerPaths]);

  const chooseInputFiles = useCallback(async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || batchStarted) return;
    const selected = await api.selectExcelFiles();
    if (!selected?.length) return;
    const supportedPaths = selected.filter(isExcelPath);
    if (supportedPaths.length !== selected.length) {
      appendLog("所选文件不是支持的 Excel 格式", "warning");
      toast.warning("仅支持 Excel 文件（xlsx、xlsm、xlsb、xls）");
    }
    if (supportedPaths.length > 0) registerPaths(supportedPaths, "file");
  }, [appendLog, batchStarted, registerPaths]);

  const scanInputDirectory = useCallback(async (directoryPath: string): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    setInputDir(directoryPath);
    setInputDirectorySelected(true);
    try {
      const scan = await api.listExcelFiles(directoryPath);
      registerPaths(scan.files, "folder");
      const skipped = scan.skippedTemporary + scan.skippedUnsupported + scan.skippedOutput;
      if (skipped > 0) {
        toast.info(`文件夹扫描完成，已跳过 ${skipped} 项`);
      }
      appendLog(`文件夹扫描完成：发现 ${scan.files.length} 个 Excel 文件，跳过 ${skipped} 项`, "success");
    } catch (error) {
      appendLog("扫描文件夹失败：" + String(error), "error");
      toast.error("文件夹扫描失败");
    }
  }, [appendLog, registerPaths]);

  const addFolder = useCallback(async (incoming: File[]): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    if (incoming.length === 1 && !isExcelFile(incoming[0]) && !droppedFolderName(incoming[0])) {
      try {
        const directoryPath = api.getPathForFile(incoming[0]);
        if (!directoryPath) throw new Error("无法读取文件夹路径");
        if (!await ensureOutputDirectory()) return;
        await scanInputDirectory(directoryPath);
        return;
      } catch (error) {
        appendLog("无法读取拖入的文件夹：" + String(error), "warning");
        toast.warning("无法读取拖入的文件夹，请双击选择文件夹");
        return;
      }
    }
    const folderNames = new Set(incoming.map(droppedFolderName).filter((name): name is string => Boolean(name)));
    if (folderNames.size !== 1 || incoming.some((file) => !droppedFolderName(file))) {
      appendLog("文件夹模式只接受 1 个完整文件夹", "warning");
      toast.warning("文件夹模式只接受 1 个完整文件夹");
      return;
    }
    const paths = incoming.filter(isExcelFile).map((file) => {
      try {
        return api.getPathForFile(file);
      } catch {
        return "";
      }
    }).filter(Boolean);
    if (paths.length === 0) {
      appendLog("拖入的文件夹中没有支持的 Excel 文件", "warning");
      toast.warning("拖入的文件夹中没有支持的 Excel 文件");
      return;
    }
    if (!await ensureOutputDirectory()) return;
    registerPaths(paths, "folder");
    const skipped = incoming.length - paths.length;
    if (skipped > 0) toast.info(`文件夹导入完成，已跳过 ${skipped} 个非 Excel 文件`);
  }, [appendLog, ensureOutputDirectory, registerPaths, scanInputDirectory]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: importSourceMode === "file" ? {
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx", ".xlsm", ".xlsb"],
    } : undefined,
    maxFiles: 0,
    multiple: true,
    disabled: batchStarted,
    getFilesFromEvent: importSourceMode === "file" ? getNativeFilesFromEvent : undefined,
    noClick: true,
    noKeyboard: true,
    onDrop: (acceptedFiles, rejections) => {
      if (rejections.length > 0) {
        const message = importSourceMode === "file"
          ? "仅支持 Excel 文件（xlsx、xlsm、xlsb、xls）"
          : "文件夹模式只接受文件夹";
        appendLog(message, "warning");
        toast.warning(message);
        return;
      }
      if (importSourceMode === "file") void addFiles(acceptedFiles);
      else void addFolder(acceptedFiles);
    },
  });

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const actionFiles = useMemo(
    () => (selectedPaths.length > 0 ? files.filter((path) => selectedSet.has(path)) : files),
    [files, selectedPaths.length, selectedSet],
  );

  const analyzeFiles = async (
    targetFiles: string[] = actionFiles,
    configPathOverride?: string,
    options: AnalyzeFilesOptions = {},
  ): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || targetFiles.length === 0 || isAnalyzing || isRunning) return;
    setBatchStarted(true);
    setIsAnalyzing(true);
    setActiveTab("pending");
    setActivePath("");
    if (!options.preserveExisting) {
      analysesRef.current = {};
      mappingsRef.current = {};
      writebackEditsRef.current = {};
      cellEditsRef.current = {};
      mappingValidationVersionsRef.current = {};
      priceRowValidationVersionsRef.current = {};
      pendingMappingValidationRef.current = null;
      mappingValidationInFlightRef.current = false;
      activeMappingValidationRef.current = null;
      if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
      setAnalyses({});
      setMappings({});
      setWritebackEdits({});
      setCellEdits({});
      setMappingValidations({});
      setMatchedOrderRowsBySheet({});
      setDetailPreviewWorkbook(null);
      setActiveMappingTarget(null);
      resultsRef.current = {};
      setResults({});
      setExpandedPath(null);
      confirmedPathsRef.current = new Set();
    }
    setProgress({ current: 0, total: targetFiles.length, phase: "analyze", path: "" });
    appendLog("开始分析 " + targetFiles.length + " 个文件");
    try {
      const effectiveConfigPath = configPathOverride ?? configPath;
      await api.analyzePriceFiles({
        files: targetFiles,
        ...(effectiveConfigPath ? { configPath: effectiveConfigPath } : {}),
      });
    } catch (error) {
      setIsAnalyzing(false);
      const manualReview = manualIssueReviewRef.current;
      if (manualReview?.phase === "analysis" && manualReview.path === targetFiles[0]) {
        manualIssueReviewRef.current = null;
        setManualIssueReviewResolution({
          path: manualReview.path,
          preferredTab: manualReview.preferredTab,
          outcome: "failed",
        });
      }
      appendLog("提交分析失败：" + String(error), "error");
    }
  };

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

  const handleAppSettingsChanged = useCallback((preferences: AppPreferences, state: AppState): void => {
    setInputDir(state.recentInputDirectory);
    setOutputDir(state.recentOutputDirectory);
    setConfigPath(state.activeBusinessConfigPath);
    setAutoRevealManualResult(preferences.autoRevealManualResult);
    setContinuousIssueReviewEnabled(preferences.continuousIssueReviewEnabled);
  }, []);

  const runPricing = async (
    targetFiles: string[] = actionFiles,
    executionType: TaskExecutionType = batchIdRef.current ? "retry" : "automatic",
  ): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || targetFiles.length === 0 || isAnalyzing || isRunning) return;
    const blockedFiles = targetFiles.filter((path) => {
      const analysis = analysesRef.current[path] ?? analyses[path];
      return !analysis || isAnalysisError(analysis) || (analysis.requiresConfirmation && !confirmedPathsRef.current.has(path));
    });
    const blockedSet = new Set(blockedFiles);
    const runnableFiles = targetFiles.filter((path) => !blockedSet.has(path));
    if (blockedFiles.length > 0) {
      appendLog(
        blockedFiles.length + " 个文件仍待确认或存在异常，已跳过；请在待确认/异常 Tab 查看",
        "warning",
      );
    }
    if (runnableFiles.length === 0) return;
    const runMappings = runnableFiles
      .map((path) => ({
        inputPath: path,
        mapping: mappingsRef.current[path] ?? analysesRef.current[path]?.suggestedMapping ?? mappings[path] ?? analyses[path]?.suggestedMapping ?? null,
        writebackRows: writebackEditsRef.current[path] ?? [],
        cellEdits: cellEditsRef.current[path] ?? [],
      }))
      .filter((item): item is { inputPath: string; mapping: PriceCheckMapping; writebackRows: PricePreviewWritebackRow[]; cellEdits: PricePreviewCellEdit[] } => item.mapping !== null);
    if (runMappings.length !== runnableFiles.length) {
      appendLog("仍有文件没有可执行字段映射，请先分析并确认", "warning");
      return;
    }
    const effectiveOutputDir = await ensureOutputDirectory();
    if (!effectiveOutputDir) return;
    setBatchStarted(true);
    setIsAnalyzing(false);
    setIsRunning(true);
    setIsPaused(false);
    const nextResults = { ...resultsRef.current };
    for (const path of runnableFiles) delete nextResults[path];
    resultsRef.current = nextResults;
    setResults((current) => {
      const next = { ...current };
      for (const path of runnableFiles) delete next[path];
      return next;
    });
    setExpandedPath(null);
    setActivePath("");
    setProgress({ current: 0, total: runnableFiles.length, phase: "run", path: "" });
    appendLog("开始核价 " + runnableFiles.length + " 个文件，结果写入：" + effectiveOutputDir);
    try {
      const runnableSet = new Set(runnableFiles);
      const remainingFiles = files.filter((path) =>
        !runnableSet.has(path) && results[path]?.status !== "completed").length;
      const response = await api.runPriceCheck({
        files: runnableFiles,
        outputDir: effectiveOutputDir,
        ...(batchIdRef.current ? { batchId: batchIdRef.current } : {}),
        batchName,
        batchNote,
        batchFiles: files,
        executionType,
        remainingFiles,
        mappings: runMappings,
        diagnostics: runnableFiles.map((path) => ({
          inputPath: path,
          issueSummaries: taskIssueSummaries(
            analysesRef.current[path]?.unmatchedRows ?? [],
            writebackEditsRef.current[path] ?? [],
          ),
        })),
        ...(configPath ? { configPath } : {}),
      });
      batchIdRef.current = response.batchId;
      setBatchId(response.batchId);
      if (outputDir) await api.setAppState({ recentOutputDirectory: outputDir });
    } catch (error) {
      setIsRunning(false);
      const manualReview = manualIssueReviewRef.current;
      if (manualReview?.phase === "run" && runnableFiles.includes(manualReview.path)) {
        manualIssueReviewRef.current = null;
        setManualIssueReviewResolution({
          path: manualReview.path,
          preferredTab: manualReview.preferredTab,
          outcome: "failed",
        });
      }
      appendLog("提交核价失败：" + String(error), "error");
    }
  };

  const chooseInputDirectory = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    const selected = await api.selectDirectory("input");
    if (!selected) return;
    await scanInputDirectory(selected);
  };

  const chooseNextBatch = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    const unresolvedFiles = files.filter((path) => results[path]?.status !== "completed");
    if (unresolvedFiles.length === 0) {
      await resetTask();
      toast.success("当前批次已完成，可以导入下一批文件");
      return;
    }
    const effectiveOutputRoot = await ensureOutputDirectory();
    if (!effectiveOutputRoot) return;
    try {
      const finished = await api.finishTaskBatch({
        ...(batchIdRef.current ? { batchId: batchIdRef.current } : {}),
        name: batchName,
        note: batchNote,
        files,
        outputRoot: effectiveOutputRoot,
        diagnostics: files.map((path) => ({
          inputPath: path,
          issueSummaries: taskIssueSummaries(
            analysesRef.current[path]?.unmatchedRows ?? [],
            writebackEditsRef.current[path] ?? [],
          ),
        })),
      });
      setHistoryRevision((current) => current + 1);
      appendLog(
        `当前批次已结束，${finished.archivedCount} 个未完成文件已归档到：${finished.unprocessedDir ?? "未处理目录"}`,
        "success",
      );
      await resetTask();
      toast.success(`已归档 ${finished.archivedCount} 个未完成文件，可以导入下一批`);
    } catch (error) {
      appendLog("结束当前批次失败：" + String(error), "error");
      toast.error(`结束当前批次失败：${String(error)}`);
    }
  };

  useEffect(() => {
    if (analysisCompletedToken === 0 || !autoRunRequestedRef.current) return;
    autoRunRequestedRef.current = false;
    const requestedPaths = autoRunTargetPathsRef.current;
    autoRunTargetPathsRef.current = [];
    const requestedSet = new Set(requestedPaths);
    const analyzedFiles = files.filter((path) => analysesRef.current[path] && (requestedSet.size === 0 || requestedSet.has(path)));
    const eligibleFiles = analyzedFiles.filter((path) => analysesRef.current[path]?.automationDecision.status === "eligible");
    const confirmCount = analyzedFiles.filter((path) => analysesRef.current[path]?.automationDecision.status === "confirm").length;
    const errorCount = analyzedFiles.filter((path) => analysesRef.current[path]?.automationDecision.status === "error").length;
    if (eligibleFiles.length === 0) {
      toast.warning(`分析完成：待确认 ${confirmCount}，异常 ${errorCount}，没有可自动核价的文件`);
      return;
    }
    toast.success(`分析完成：自动核价 ${eligibleFiles.length}，待确认 ${confirmCount}，异常 ${errorCount}`);
    void runPricing(eligibleFiles, batchIdRef.current ? "retry" : "automatic");
  }, [analysisCompletedToken]);

  const scanFiles = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    let targetFiles = actionFiles;
    if (inputDirectorySelected && inputDir) {
      try {
        const scan = await api.listExcelFiles(inputDir);
        const discovered = scan.files;
        if (discovered.length > MAX_INPUT_FILES) {
          appendLog(`文件夹超过 ${MAX_INPUT_FILES} 个文件上限，未开始分析`, "error");
          return;
        }
        setFiles(discovered);
        const scannedTime = new Date().toLocaleString("zh-CN", { hour12: false });
        setImportedAt(Object.fromEntries(discovered.map((path) => [path, scannedTime])));
        setSelectedPaths([]);
        targetFiles = discovered;
        if (discovered.length === 0) {
          appendLog("所选文件夹中没有发现 Excel 文件", "warning");
          return;
        }
        appendLog("扫描文件夹发现 " + discovered.length + " 个 Excel 文件", "success");
      } catch (error) {
        appendLog("扫描文件夹失败：" + String(error), "error");
        return;
      }
    }
    if (targetFiles.length === 0) {
      appendLog("请先选择目标文件夹或拖入 Excel 文件", "warning");
      return;
    }
    await analyzeFiles(targetFiles);
  };

  const chooseOutputDirectory = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const selected = await api.selectDirectory("output");
    if (selected) setOutputDir(selected);
  };

  const chooseConfigFile = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const selected = await api.selectConfig();
    if (selected) {
      setConfigPath(selected);
      appendLog("已选择配置文件：" + selected, "success");
    }
  };

  const openCurrentConfig = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || !configPath) {
      appendLog("当前没有可打开的配置文件", "warning");
      return;
    }
    const error = await api.openPath(configPath);
    if (error) appendLog(error, "warning");
  };

  const openSourceDirectory = async (path: string): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const error = await api.openPath(parentDirectory(path));
    if (error) appendLog(error, "warning");
  };

  const exportLogs = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    const exportedPath = await api.exportRuntimeLog();
    appendLog(exportedPath ? "日志已导出：" + exportedPath : "已取消日志导出", exportedPath ? "success" : "info");
  };

  const resetTask = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (api && (isAnalyzing || isRunning)) {
      try {
        await api.stopProcessing();
      } catch {
        // Reset continues even if the worker has already exited.
      }
    }
    setIsAnalyzing(false);
    setIsRunning(false);
    setIsPaused(false);
    setBatchStarted(false);
    batchIdRef.current = null;
    batchNameEditedRef.current = false;
    setBatchId(null);
    setBatchName("");
    setBatchNote("");
    setEditingBatchName(false);
    setActivePath("");
    setFiles([]);
    setImportedAt({});
    setImportModes({});
    setSelectedPaths([]);
    setAnalyses({});
    setMappings({});
    setWritebackEdits({});
    setCellEdits({});
    setMappingValidations({});
    setMatchedOrderRowsBySheet({});
    setResults({});
    setExpandedPath(null);
    setDetailPath(null);
    analysesRef.current = {};
    mappingsRef.current = {};
    writebackEditsRef.current = {};
    cellEditsRef.current = {};
    mappingValidationVersionsRef.current = {};
    priceRowValidationVersionsRef.current = {};
    pendingMappingValidationRef.current = null;
    mappingValidationInFlightRef.current = false;
    activeMappingValidationRef.current = null;
    if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
    confirmedPathsRef.current = new Set();
    resultsRef.current = {};
    manualIssueReviewRef.current = null;
    setManualIssueReviewResolution(null);
    autoRunTargetPathsRef.current = [];
    userTabLockedRef.current = false;
    batchTaskWasActiveRef.current = false;
    setResetConfirmOpen(false);
    setNextBatchConfirmOpen(false);
    setInputDirectorySelected(false);
    setActiveTab("pending");
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    setPageIndex(0);
    setLogs([]);
  };

  const requestResetTask = (): void => {
    setResetConfirmOpen(true);
  };

  const removeFile = (path: string): void => {
    setFiles((current) => current.filter((item) => item !== path));
    setSelectedPaths((current) => current.filter((item) => item !== path));
    setAnalyses((current) => {
      const next = { ...current };
      delete next[path];
      analysesRef.current = next;
      return next;
    });
    setMappings((current) => {
      const next = { ...current };
      delete next[path];
      mappingsRef.current = next;
      return next;
    });
    setResults((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    confirmedPathsRef.current.delete(path);
    setImportedAt((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setImportModes((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setMatchedOrderRowsBySheet((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    if (detailPath === path) setDetailPath(null);
    if (expandedPath === path) setExpandedPath(null);
  };

  const toggleSelected = (path: string): void => {
    setSelectedPaths((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  };

  const toggleAllSelected = (): void => {
    const visiblePaths = files.filter((path) => {
      const status = statusForFile(
        path,
        analyses[path],
        results[path],
        activePath,
        isAnalyzing || isRunning,
        confirmedPathsRef.current.has(path),
      );
      return tabForStatus(status) === activeTab;
    });
    const allSelected = visiblePaths.length > 0 && visiblePaths.every((path) => selectedSet.has(path));
    setSelectedPaths((current) => (allSelected ? current.filter((path) => !visiblePaths.includes(path)) : Array.from(new Set([...current, ...visiblePaths]))));
  };

  const queueMappingValidation = (path: string, mapping: PriceCheckMapping): void => {
    const version = (mappingValidationVersionsRef.current[path] ?? 0) + 1;
    mappingValidationVersionsRef.current[path] = version;
    setMappingValidations((current) => ({ ...current, [path]: { status: "stale", result: current[path]?.result ?? null } }));
    if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
    mappingValidationTimerRef.current = setTimeout(() => sendMappingValidation(path, mapping, version), 500);
  };

  const revalidateMapping = (path: string): void => {
    const mapping = mappingsRef.current[path] ?? mappings[path];
    if (!mapping) return;
    const version = (mappingValidationVersionsRef.current[path] ?? 0) + 1;
    mappingValidationVersionsRef.current[path] = version;
    if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
    mappingValidationTimerRef.current = null;
    setMappingValidations((current) => ({ ...current, [path]: { status: "stale", result: current[path]?.result ?? null } }));
    sendMappingValidation(path, mapping, version);
  };

  const commitMapping = (path: string, mapping: PriceCheckMapping): void => {
    const nextWritebackEdits = { ...writebackEditsRef.current };
    delete nextWritebackEdits[path];
    writebackEditsRef.current = nextWritebackEdits;
    setWritebackEdits(nextWritebackEdits);
    const nextCellEdits = { ...cellEditsRef.current };
    delete nextCellEdits[path];
    cellEditsRef.current = nextCellEdits;
    setCellEdits(nextCellEdits);
    mappingsRef.current = { ...mappingsRef.current, [path]: mapping };
    setMappings((current) => ({ ...current, [path]: mapping }));
    queueMappingValidation(path, mapping);
  };

  const updateMapping = (path: string, orderSheet: string, pricingSheet: string): void => {
    const analysis = analyses[path];
    if (!analysis) return;
    const order = analysis.orderSheetCandidates.find((item) => item.sheetName === orderSheet);
    const pricing = analysis.pricingSheetCandidates.find((item) => item.sheetName === pricingSheet);
    if (order && pricing) {
      const nextMapping = buildMapping(order, pricing);
      commitMapping(path, nextMapping);
    }
  };

  const confirmAndContinue = async (path: string): Promise<void> => {
    const mapping = mappingsRef.current[path] ?? mappings[path];
    const validation = mappingValidations[path];
    if (!mappingIsComplete(mapping) || validation?.status !== "ready" || (validation.result?.errors.length ?? 1) > 0) {
      toast.error("请先完成字段映射并等待试算通过");
      return;
    }
    confirmedPathsRef.current.add(path);
    if (continuousIssueReviewEnabled) {
      manualIssueReviewRef.current = { path, preferredTab: "confirm", phase: "run" };
    }
    setDetailPath(null);
    toast.success("映射已确认，开始处理当前文件");
    await runPricing([path], "manual");
  };

  const retryAnalysis = async (path: string): Promise<void> => {
    if (continuousIssueReviewEnabled) {
      manualIssueReviewRef.current = { path, preferredTab: "error", phase: "analysis" };
    }
    setDetailPath(null);
    const nextWritebackEdits = { ...writebackEditsRef.current };
    delete nextWritebackEdits[path];
    writebackEditsRef.current = nextWritebackEdits;
    setWritebackEdits(nextWritebackEdits);
    const nextCellEdits = { ...cellEditsRef.current };
    delete nextCellEdits[path];
    cellEditsRef.current = nextCellEdits;
    setCellEdits(nextCellEdits);
    setResults((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setAnalyses((current) => {
      const next = { ...current };
      delete next[path];
      analysesRef.current = next;
      return next;
    });
    setMappings((current) => {
      const next = { ...current };
      delete next[path];
      mappingsRef.current = next;
      return next;
    });
    setMappingValidations((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setMatchedOrderRowsBySheet((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    delete mappingValidationVersionsRef.current[path];
    setMappingValidations((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    delete mappingValidationVersionsRef.current[path];
    confirmedPathsRef.current.delete(path);
    setActiveTab("pending");
    autoRunRequestedRef.current = true;
    autoRunTargetPathsRef.current = [path];
    await analyzeFiles([path], undefined, { preserveExisting: true });
  };

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
            isAnalyzing || isRunning,
            confirmedPathsRef.current.has(path),
          ),
        ]),
      ),
    [activePath, analyses, files, isAnalyzing, isRunning, results],
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
        { pending: 0, running: 0, ready: 0, success: 0, warning: 0, error: 0 },
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
        { pending: 0, confirm: 0, error: 0, success: 0 },
      ),
    [progressDots],
  );

  const visibleFiles = useMemo(
    () => files.filter((path) => tabForStatus(fileStatusByPath[path]) === activeTab),
    [activeTab, fileStatusByPath, files],
  );

  useEffect(() => {
    setPageIndex(0);
  }, [activeTab, pageSize]);

  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / pageSize));
  const pagedFiles = useMemo(
    () => visibleFiles.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [pageIndex, pageSize, visibleFiles],
  );

  const tableColumns = useMemo<ColumnDef<string>[]>(
    () => {
      const selectColumn: ColumnDef<string> = { id: "select", header: "", size: 38, minSize: 38, maxSize: 38, enableSorting: false, enableHiding: false, enablePinning: false, enableResizing: false };
      const indexColumn: ColumnDef<string> = { id: "index", header: "序号", size: 64, enableSorting: false, enableHiding: false, enablePinning: false, enableResizing: false };
      const fileColumn: ColumnDef<string> = { id: "fileName", header: "原始文件名", size: 240, minSize: 180, maxSize: 360, accessorFn: fileNameFromPath };
      const actionColumn: ColumnDef<string> = { id: "actions", header: "操作", size: activeTab === "pending" ? 104 : 80, minSize: 64, maxSize: 180, enableSorting: false, enableHiding: false, enablePinning: false, enableResizing: false };
      const orderColumn: ColumnDef<string> = { id: "orderSheet", header: "订单 Sheet", size: 170, accessorFn: (path) => (mappings[path] ?? analyses[path]?.suggestedMapping)?.orderSheet ?? "" };
      const pricingColumn: ColumnDef<string> = { id: "pricingSheet", header: "核价 Sheet", size: 190, accessorFn: (path) => (mappings[path] ?? analyses[path]?.suggestedMapping)?.pricingSheet ?? "" };
      const coverageColumn: ColumnDef<string> = { id: "coverage", header: "匹配率", size: 230, minSize: 140, accessorFn: (path) => results[path]?.coverage ?? analyses[path]?.coverage ?? -1 };
      if (activeTab === "pending") return [selectColumn, indexColumn, fileColumn,
        { id: "importMode", header: "导入方式", size: 220, accessorFn: (path) => importModes[path] ?? "file" },
        { id: "status", header: "处理阶段", size: 240, accessorFn: (path) => fileStatusByPath[path] },
        { id: "createdAt", header: "导入时间", size: 300, accessorFn: (path) => importedAt[path] ?? "" }, actionColumn];
      if (activeTab === "confirm") return [selectColumn, indexColumn, fileColumn, orderColumn, pricingColumn, coverageColumn,
        { id: "evidence", header: "试算行数", size: 140, accessorFn: (path) => analyses[path]?.automationDecision.evaluatedRows ?? 0 },
        { id: "issue", header: "待确认原因", size: 340, minSize: 180, accessorFn: (path) => analyses[path]?.automationDecision.reasons.join("；") ?? "" }, actionColumn];
      if (activeTab === "error") return [selectColumn, indexColumn, fileColumn,
        { id: "issue", header: "问题摘要", accessorFn: (path) => results[path]?.message ?? analyses[path]?.automationDecision.reasons.join("；") ?? "" },
        { id: "rows", header: "匹配行数", accessorFn: (path) => results[path]?.matchedRows ?? 0 }, coverageColumn,
        { id: "completedAt", header: "更新时间", accessorFn: (path) => results[path]?.completedAt ?? importedAt[path] ?? "" }, actionColumn];
      return [selectColumn, indexColumn, fileColumn, orderColumn, pricingColumn,
        { id: "rows", header: "匹配行数", accessorFn: (path) => results[path]?.matchedRows ?? 0 }, coverageColumn,
        { id: "completedAt", header: "完成时间", accessorFn: (path) => results[path]?.completedAt ?? "" }, actionColumn];
    },
    [activeTab, analyses, fileStatusByPath, importModes, importedAt, mappings, results],
  );

  const fileTable = useReactTable({
    data: pagedFiles,
    columns: tableColumns,
    defaultColumn: { size: 180, minSize: 80, maxSize: 560 },
    state: { sorting, columnVisibility, columnSizing, columnPinning: { left: pinnedFileColumns[activeTab], right: [] } satisfies ColumnPinningState },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const visibleFileColumns = [...fileTable.getLeftVisibleLeafColumns(), ...fileTable.getCenterVisibleLeafColumns(), ...fileTable.getRightVisibleLeafColumns()];
  const fileHeadersByColumn = new Map(fileTable.getHeaderGroups()[0].headers.map((header) => [header.column.id, header]));
  const visibleFileHeaders = visibleFileColumns.map((column) => fileHeadersByColumn.get(column.id)).filter((header) => header !== undefined);
  const toggleFileColumnPin = (columnId: string): void => {
    setPinnedFileColumns((current) => {
      const pinned = current[activeTab];
      return { ...current, [activeTab]: pinned.includes(columnId) ? pinned.filter((id) => id !== columnId) : [...pinned, columnId] };
    });
  };
  const filePinnedStyle = (column: Column<string, unknown>, header = false): CSSProperties => column.getIsPinned() === "left" ? {
    left: `${column.getStart("left")}px`,
    position: "sticky",
    width: `${column.getSize()}px`,
    zIndex: header ? 7 : 4,
  } : { width: `${column.getSize()}px` };
  const tableRows = fileTable.getRowModel().rows;
  const shouldVirtualizeRows = tableRows.length > 100 && expandedPath === null;
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualizeRows ? tableRows.length : 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 39,
    overscan: 12,
  });
  const renderedTableRows = shouldVirtualizeRows
    ? rowVirtualizer.getVirtualItems().map((virtualRow) => ({ row: tableRows[virtualRow.index], virtualRow }))
    : tableRows.map((row) => ({ row, virtualRow: null }));
  const hasTableRows = renderedTableRows.length > 0;

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
        setHighlightedResultPath((current) => current === pendingResultRevealPath ? null : current);
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
  }, [pageIndex, pageSize, pendingResultRevealPath, shouldVirtualizeRows, visibleFiles]);

  useEffect(() => () => {
    if (resultRevealHighlightTimerRef.current) clearTimeout(resultRevealHighlightTimerRef.current);
  }, []);

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
            : tabCounts.success > 0
              ? "本批已完成"
              : Object.keys(analyses).length > 0
                ? "分析已完成"
                : "批次已停止";
  const detailAnalysis = detailPath ? analyses[detailPath] : undefined;
  const detailResult = detailPath ? results[detailPath] : undefined;
  const detailMapping = detailPath ? mappings[detailPath] ?? detailAnalysis?.suggestedMapping ?? null : null;
  const detailValidation: MappingValidationState = detailPath ? mappingValidations[detailPath] ?? { status: "idle", result: null } : { status: "idle", result: null };
  const detailSingleShipmentMatchingEnabled = (
    detailValidation.result?.singleShipmentMatching
    ?? detailAnalysis?.singleShipmentMatching
  )?.enabled === true;
  const detailMatchedOrderRows = detailPath && detailMapping && detailValidation.status === "ready"
    ? matchedOrderRowsBySheet[detailPath]?.[detailMapping.orderSheet] ?? []
    : [];
  const detailWritebackRows = useMemo(() => {
    if (!detailContentReady || !detailPath || detailValidation.status !== "ready") return [];
    const baseRows = detailValidation.result?.writebackRows ?? [];
    const edits = writebackEdits[detailPath] ?? [];
    if (edits.length === 0) return baseRows;
    const editsByRow = new Map(edits.map((row) => [row.sourceRow, row]));
    return baseRows.map((row) => editsByRow.get(row.sourceRow) ?? row);
  }, [detailContentReady, detailPath, detailValidation, writebackEdits]);
  const detailQuantityIssues = useMemo(
    () => detailWritebackRows.filter((row) => row.quantityError),
    [detailWritebackRows],
  );
  const detailUnmatchedIssues = useMemo(
    () => detailContentReady
      ? detailValidation.result?.unmatchedRows ?? detailAnalysis?.unmatchedRows ?? []
      : [],
    [detailAnalysis?.unmatchedRows, detailContentReady, detailValidation.result?.unmatchedRows],
  );
  const selectedIssueDetails = useMemo(() => {
    if (!issueDetailsRequest) return [];
    return issueDetailsRequest.kind === "quantity"
      ? quantityIssueDetails(detailQuantityIssues)
      : unmatchedIssueDetails(detailUnmatchedIssues);
  }, [detailQuantityIssues, detailUnmatchedIssues, issueDetailsRequest]);
  const openUnmatchedDetails = useCallback((summary: string, sourceRow: number | null = null): void => {
    setIssueDetailsRequest({ kind: "unmatched", sourceRow, summary });
  }, []);
  const openSelectedRowDetails = useCallback((sourceRow: number): void => {
    if (detailQuantityIssues.some((issue) => issue.sourceRow === sourceRow)) {
      setIssueDetailsRequest({
        kind: "quantity",
        sourceRow,
        summary: `已定位第 ${sourceRow} 行，请查看数量计算问题`,
      });
      return;
    }
    if (detailUnmatchedIssues.some((issue) => issue.sourceRow === sourceRow)) {
      setIssueDetailsRequest({
        kind: "unmatched",
        sourceRow,
        summary: `已定位第 ${sourceRow} 行，请查看具体未匹配原因`,
      });
    }
  }, [detailQuantityIssues, detailUnmatchedIssues]);
  const editDetailWritebackRow = useCallback((
    row: PricePreviewWritebackRow,
    field: "pricingPrice" | "priceDifference" | "quantity",
  ): void => {
    if (!detailPath) return;
    const current = writebackEditsRef.current[detailPath] ?? [];
    const nextRows = [...current.filter((item) => item.sourceRow !== row.sourceRow), row]
      .sort((left, right) => left.sourceRow - right.sourceRow);
    const next = { ...writebackEditsRef.current, [detailPath]: nextRows };
    writebackEditsRef.current = next;
    setWritebackEdits(next);
    const versionKey = `${detailPath}\u0000${row.sourceRow}`;
    if (field !== "quantity") {
      // 后续人工金额编辑优先，作废该行尚未返回的数量核价结果。
      priceRowValidationVersionsRef.current[versionKey] =
        (priceRowValidationVersionsRef.current[versionKey] ?? 0) + 1;
      return;
    }
    if (!detailMapping) return;
    const api = getDesktopAPI();
    if (!api) {
      toast.error("Electron 接口未加载，无法重新核价");
      return;
    }
    const requestVersion = (priceRowValidationVersionsRef.current[versionKey] ?? 0) + 1;
    priceRowValidationVersionsRef.current[versionKey] = requestVersion;
    void api.recalculatePriceRow({
      inputPath: detailPath,
      mapping: detailMapping,
      requestVersion,
      rowEdit: { sourceRow: row.sourceRow, quantity: row.quantity },
      cellEdits: cellEditsRef.current[detailPath] ?? [],
      configPath: configPath || undefined,
    }).catch((error: unknown) => {
      if (priceRowValidationVersionsRef.current[versionKey] !== requestVersion) return;
      toast.error(`第 ${row.sourceRow} 行重新核价请求失败：${String(error)}`);
    });
  }, [configPath, detailMapping, detailPath]);
  const detailPreviewCandidates = useMemo<ExcelPreviewCandidate[]>(() => {
    if (!detailAnalysis) return [];
    const rolesBySheet = new Map<string, Set<ExcelPreviewCandidate["roles"][number]>>();
    const scoresBySheet = new Map<string, ExcelPreviewCandidate["scores"]>();
    for (const candidate of detailAnalysis.orderSheetCandidates) {
      const roles = rolesBySheet.get(candidate.sheetName) ?? new Set();
      roles.add("order");
      rolesBySheet.set(candidate.sheetName, roles);
      scoresBySheet.set(candidate.sheetName, { ...scoresBySheet.get(candidate.sheetName), order: candidate.score });
    }
    for (const candidate of detailAnalysis.pricingSheetCandidates) {
      const roles = rolesBySheet.get(candidate.sheetName) ?? new Set();
      roles.add("pricing");
      rolesBySheet.set(candidate.sheetName, roles);
      scoresBySheet.set(candidate.sheetName, { ...scoresBySheet.get(candidate.sheetName), pricing: candidate.score });
    }
    return Array.from(rolesBySheet, ([name, roles]) => ({ name, roles: Array.from(roles), scores: scoresBySheet.get(name) }));
  }, [detailAnalysis]);
  const currentDetailDrawerBounds = detailDrawerBounds(detailDrawerViewportWidth);
  const currentDetailSidebarBounds = detailSidebarBounds(detailDrawerWidth);

  useEffect(() => {
    const candidateNames = detailPreviewCandidates.map((candidate) => candidate.name);
    if (!detailPath || candidateNames.length === 0) {
      setDetailPreviewSheetName("");
      return;
    }
    setDetailPreviewSheetName((current) => {
      if (candidateNames.includes(current)) return current;
      if (detailMapping?.orderSheet && candidateNames.includes(detailMapping.orderSheet)) return detailMapping.orderSheet;
      return candidateNames[0];
    });
  }, [detailMapping?.orderSheet, detailPath, detailPreviewCandidates]);

  useEffect(() => {
    setDetailPreviewWorkbook(null);
    setActiveMappingTarget(null);
  }, [detailPath]);

  const selectMappingTarget = (target: MappingFieldTarget | null): void => {
    setActiveMappingTarget(target);
    if (!target || !detailMapping) return;
    const pricingTarget = target.startsWith("pricing") || target.startsWith("quantityTierColumns");
    setDetailPreviewSheetName(pricingTarget ? detailMapping.pricingSheet : detailMapping.orderSheet);
  };

  const changeMappingColumn = (target: MappingFieldTarget, column: number | null, header: string, fromPreview = false): void => {
    if (!detailPath || !detailMapping || target.endsWith("HeaderRow")) return;
    const pricingTarget = target.startsWith("pricing") || target.startsWith("quantityTierColumns");
    const expectedSheet = pricingTarget ? detailMapping.pricingSheet : detailMapping.orderSheet;
    if (fromPreview && detailPreviewSheetName !== expectedSheet) return;
    const conflict = column === null ? null : mappingColumnConflict(detailMapping, target, column);
    if (conflict) {
      toast.warning(`该列已映射为“${conflict}”，请先调整原字段`);
      return;
    }
    commitMapping(detailPath, applyMappingColumn(detailMapping, target, column, header));
    const pairMatch = column === null ? null : /^skuQtyPairs\.(\d+)\.(qtyColumn|skuColumn)$/.exec(target);
    if (pairMatch && fromPreview) {
      const nextField = pairMatch[2] === "qtyColumn" ? "skuColumn" : "mergedQtyColumn";
      setActiveMappingTarget(`skuQtyPairs.${Number(pairMatch[1])}.${nextField}`);
    } else {
      setActiveMappingTarget(null);
    }
  };

  const selectMappingColumn = (column: number, header: string): void => {
    if (!activeMappingTarget) return;
    changeMappingColumn(activeMappingTarget, column, header, true);
  };

  const selectMappingRow = (row: number): void => {
    if (!detailPath || !detailMapping || !activeMappingTarget?.endsWith("HeaderRow")) return;
    if (activeMappingTarget === "orderHeaderRow" && detailPreviewSheetName === detailMapping.orderSheet) commitMapping(detailPath, { ...detailMapping, orderHeaderRow: row });
    if (activeMappingTarget === "pricingHeaderRow" && detailPreviewSheetName === detailMapping.pricingSheet) commitMapping(detailPath, { ...detailMapping, pricingHeaderRow: row });
    if (activeMappingTarget === "pricingQuantityHeaderRow" && detailPreviewSheetName === detailMapping.pricingSheet) commitMapping(detailPath, { ...detailMapping, pricingQuantityHeaderRow: row });
    setActiveMappingTarget(null);
  };

  useEffect(() => {
    if (!activeMappingTarget) return;
    const cancelSelection = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setActiveMappingTarget(null);
      }
    };
    window.addEventListener("keydown", cancelSelection, true);
    return () => window.removeEventListener("keydown", cancelSelection, true);
  }, [activeMappingTarget]);

  const startDetailDrawerResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    detailDrawerCustomWidthRef.current = true;
    detailDrawerResizeRef.current = { startX: event.clientX, startWidth: detailDrawerWidth };
  };

  const resizeDetailDrawerWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = detailDrawerWidth + DETAIL_DRAWER_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = detailDrawerWidth - DETAIL_DRAWER_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = currentDetailDrawerBounds.min;
    if (event.key === "End") nextWidth = currentDetailDrawerBounds.max;
    if (nextWidth === null) return;
    event.preventDefault();
    detailDrawerCustomWidthRef.current = true;
    setDetailDrawerWidth(clampDetailDrawerWidth(nextWidth));
  };

  const openDetailDrawer = (path: string): void => {
    detailDrawerCustomWidthRef.current = false;
    setDetailDrawerWidth(defaultDetailDrawerWidth());
    setDetailPath(path);
  };

  useEffect(() => {
    if (!manualIssueReviewResolution) return;
    const { path, preferredTab, outcome } = manualIssueReviewResolution;
    const currentStatus = fileStatusByPath[path];
    const currentTab = currentStatus ? tabForStatus(currentStatus) : preferredTab;
    const currentStillNeedsReview = currentTab === "confirm" || currentTab === "error";

    let targetPath: string | null = null;
    let targetTab: IssueReviewTab | null = null;
    if (outcome === "failed") {
      targetPath = path;
      targetTab = "error";
    } else if (outcome !== "completed" || currentStillNeedsReview) {
      targetPath = path;
      targetTab = currentStillNeedsReview ? currentTab : preferredTab;
    } else {
      const currentIndex = files.indexOf(path);
      const orderedPaths = currentIndex < 0
        ? files
        : [...files.slice(currentIndex + 1), ...files.slice(0, currentIndex)];
      const findInTab = (tab: IssueReviewTab): string | undefined =>
        orderedPaths.find((candidate) => tabForStatus(fileStatusByPath[candidate]) === tab);
      const alternateTab: IssueReviewTab = preferredTab === "confirm" ? "error" : "confirm";
      targetPath = findInTab(preferredTab) ?? findInTab(alternateTab) ?? null;
      targetTab = targetPath
        ? tabForStatus(fileStatusByPath[targetPath]) as IssueReviewTab
        : null;
    }

    setManualIssueReviewResolution(null);
    if (!targetPath || !targetTab) {
      if (outcome === "completed" && autoRevealManualResult) {
        setActiveTab("success");
        setPendingResultRevealPath(path);
      }
      return;
    }

    userTabLockedRef.current = true;
    setActiveTab(targetTab);
    const targetFiles = files.filter((candidate) => tabForStatus(fileStatusByPath[candidate]) === targetTab);
    const targetIndex = targetFiles.indexOf(targetPath);
    setPageIndex(targetIndex < 0 ? 0 : Math.floor(targetIndex / pageSize));
    openDetailDrawer(targetPath);
    setHighlightedResultPath(targetPath);
    if (resultRevealHighlightTimerRef.current) clearTimeout(resultRevealHighlightTimerRef.current);
    resultRevealHighlightTimerRef.current = setTimeout(() => {
      setHighlightedResultPath((current) => current === targetPath ? null : current);
    }, RESULT_REVEAL_HIGHLIGHT_MS);
  }, [autoRevealManualResult, fileStatusByPath, files, manualIssueReviewResolution, pageSize, setActiveTab]);

  // 批次从运行中结束时：自动切到有结果的 Tab，单文件待确认则打开详情
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

    if (tabCounts.confirm === 1) {
      const confirmPath = files.find((path) => tabForStatus(fileStatusByPath[path]) === "confirm");
      if (confirmPath) openDetailDrawer(confirmPath);
    }
  }, [batchStarted, fileStatusByPath, files, isTaskActive, setActiveTab, tabCounts]);

  const batchNextAction = useMemo(() => {
    if (isTaskActive || !batchStarted) return null;
    if (tabCounts.confirm > 0) {
      const confirmPaths = files.filter((path) => tabForStatus(fileStatusByPath[path]) === "confirm");
      return {
        label: confirmPaths.length === 1 ? "查看详情" : "去确认",
        icon: FileCheck2,
        className: "cyber-action is-start is-batch-next",
        onClick: () => {
          userTabLockedRef.current = true;
          setActiveTab("confirm");
          if (confirmPaths.length === 1) openDetailDrawer(confirmPaths[0]!);
        },
      };
    }
    if (tabCounts.error > 0) {
      return {
        label: "查看异常",
        icon: CircleHelp,
        className: "cyber-action is-start is-batch-next",
        onClick: () => {
          userTabLockedRef.current = true;
          setActiveTab("error");
        },
      };
    }
    if (tabCounts.pending > 0) {
      return {
        label: "继续未完成",
        icon: Play,
        className: "cyber-action is-start is-batch-next",
        onClick: () => {
          const unfinishedFiles = files.filter((path) => results[path]?.status !== "completed");
          if (unfinishedFiles.length === 0) return;
          const needsAnalysis = unfinishedFiles.some((path) => !analysesRef.current[path] && !analyses[path]);
          userTabLockedRef.current = false;
          if (needsAnalysis) {
            autoRunRequestedRef.current = true;
            autoRunTargetPathsRef.current = unfinishedFiles;
            void analyzeFiles(unfinishedFiles);
          } else {
            void runPricing(unfinishedFiles, "retry");
          }
        },
      };
    }
    if (tabCounts.success > 0) {
      return {
        label: "处理下一批",
        icon: FilePlus2,
        className: "cyber-action is-start is-batch-next",
        onClick: () => { void chooseNextBatch(); },
      };
    }
    return null;
  }, [analyses, batchStarted, fileStatusByPath, files, isTaskActive, results, setActiveTab, tabCounts]);

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

  const startDetailSidebarResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    detailSidebarResizeRef.current = { startX: event.clientX, startWidth: detailSidebarWidth };
  };

  const resizeDetailSidebarWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = detailSidebarWidth + DETAIL_SIDEBAR_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = detailSidebarWidth - DETAIL_SIDEBAR_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = currentDetailSidebarBounds.min;
    if (event.key === "End") nextWidth = currentDetailSidebarBounds.max;
    if (nextWidth === null) return;
    event.preventDefault();
    setDetailSidebarWidth(clampDetailSidebarWidth(nextWidth, detailDrawerWidth));
  };

  const startCurrentTask = async (): Promise<void> => {
    if (isAnalyzing || isRunning) {
      toast.info("当前任务正在处理中");
      return;
    }
    if (actionFiles.length === 0) {
      toast.warning("请先导入 Excel 文件");
      return;
    }
    const needsAnalysis = actionFiles.some((path) => !analysesRef.current[path] && !analyses[path]);
    if (needsAnalysis) {
      autoRunRequestedRef.current = true;
      autoRunTargetPathsRef.current = actionFiles;
      await analyzeFiles(actionFiles);
    }
    else await runPricing(actionFiles);
  };

  const togglePauseTask = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    if (!isAnalyzing && !isRunning) {
      toast.info("当前没有运行中的任务");
      return;
    }
    if (isPaused) await api.resumeProcessing();
    else await api.pauseProcessing();
  };

  const stopCurrentTask = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api) return;
    if (!isAnalyzing && !isRunning) {
      toast.info("当前没有可停止的任务");
      return;
    }
    await api.stopProcessing();
  };

  const renderTaskActions = (className: string, showReset = false, showNext = false): React.JSX.Element => {
    const BatchNextIcon = batchNextAction?.icon ?? FileCheck2;
    return <div className={className} aria-label="快捷操作">
      {!batchStarted ? <SidebarTooltip label="开始处理" enabled={sidebarCollapsed}><button type="button" aria-label="开始处理" className="cyber-action is-start" onClick={() => { userTabLockedRef.current = false; void startCurrentTask(); }} disabled={actionFiles.length === 0 || isTaskActive}><Play /><strong>开始处理</strong></button></SidebarTooltip> : null}
      {isTaskActive ? <SidebarTooltip label={isPaused ? "继续任务" : "暂停任务"} enabled={sidebarCollapsed}><button type="button" aria-label={isPaused ? "继续任务" : "暂停任务"} className="cyber-action is-pause" onClick={() => void togglePauseTask()} disabled={!isTaskActive}>{isPaused ? <Play /> : <Pause />}<strong>{isPaused ? "继续任务" : "暂停任务"}</strong></button></SidebarTooltip> : null}
      {isTaskActive ? <SidebarTooltip label="停止任务" enabled={sidebarCollapsed}><button type="button" aria-label="停止任务" className="cyber-action is-stop" onClick={() => void stopCurrentTask()} disabled={!isTaskActive}><CircleStop /><strong>停止任务</strong></button></SidebarTooltip> : null}
      {showNext && batchNextAction ? (
        <button type="button" aria-label={batchNextAction.label} className={batchNextAction.className} onClick={batchNextAction.onClick}>
          <BatchNextIcon /><strong>{batchNextAction.label}</strong>
        </button>
      ) : null}
      {showReset && !batchStarted ? <button type="button" aria-label="重置本批" className="cyber-action is-reset" onClick={requestResetTask} disabled={!hasResettableTaskState}><RefreshCw /><strong>重置本批</strong></button> : null}
      {showReset && batchStarted && !isTaskActive && tabCounts.confirm + tabCounts.error + tabCounts.pending > 0 ? (
        <button type="button" aria-label="结束本批并处理下一批" className="cyber-action is-reset" onClick={() => setNextBatchConfirmOpen(true)}>
          <FilePlus2 /><strong>结束并下一批</strong>
        </button>
      ) : null}
    </div>;
  };

  const showComingSoon = (label: string): void => {
    toast.info(label + "正在建设中");
  };

  const activeNavigationItem = navigationItems.find((item) => item.key === activePage) ?? navigationItems[0];
  const ActiveNavigationIcon = activeNavigationItem.icon;

  return (
    <TooltipProvider delayDuration={220} skipDelayDuration={80}>
    <MotionConfig reducedMotion="user">
      <main className={"cyber-app" + (sidebarCollapsed ? " is-sidebar-collapsed" : "") + (detailPath ? " is-detail-open" : "")} ref={shellRef}>
        <Toaster
          className="cyber-toaster"
          position="top-left"
          closeButton
          expand
          visibleToasts={5}
          theme={theme}
          duration={1_000}
          gap={8}
          offset={16}
          toastOptions={{
            classNames: {
              toast: "cyber-toast",
              title: "cyber-toast-title",
              icon: "cyber-toast-icon",
              closeButton: "cyber-toast-close",
            },
          }}
        />

        <div className="cyber-window-drag" aria-hidden="true" />
        <div className="cyber-window-controls" aria-label="窗口控制">
          <button type="button" aria-label="最小化" onClick={() => void getDesktopAPI()?.minimizeWindow()}><Minus /></button>
          <button type="button" aria-label="最大化或还原" onClick={() => void getDesktopAPI()?.toggleMaximizeWindow()}><Square /></button>
          <button type="button" className="is-close" aria-label="关闭" onClick={() => void getDesktopAPI()?.closeWindow()}><X /></button>
        </div>

        <aside className="cyber-sidebar">
          <div className="cyber-brand">
            <img src={brandExcelUrl} alt="" />
            <div><strong>Excel 批量核价</strong><span>快速 · 准确</span></div>
          </div>

          <nav className="cyber-nav" aria-label="主导航">
            {navigationItems.map(({ key, label, icon: Icon }) => {
              const isActive = activePage === key;
              const navigationButton = (
                <button
                  type="button"
                  className={isActive ? "is-active" : undefined}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setActivePage(key)}
                >
                  <Icon /><span>{label}</span>
                </button>
              );
              return <SidebarTooltip label={label} enabled={sidebarCollapsed} key={key}>{navigationButton}</SidebarTooltip>;
            })}
          </nav>

          {sidebarCollapsed && activePage === "files" && files.length > 0 ? renderTaskActions("cyber-rail-actions", true) : null}

          <div className="cyber-sidebar-tools">
            <SidebarTooltip label="配置中心" enabled={sidebarCollapsed}><button type="button" aria-label="配置中心" onClick={() => setActivePage("config")}><Settings /></button></SidebarTooltip>
            <SidebarTooltip label="帮助" enabled={sidebarCollapsed}><button type="button" aria-label="帮助" onClick={() => showComingSoon("帮助中心")}><CircleHelp /></button></SidebarTooltip>
            <SidebarTooltip label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} enabled={sidebarCollapsed}><button type="button" aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={toggleTheme}>{theme === "dark" ? <Moon /> : <Sun />}</button></SidebarTooltip>
            <SidebarTooltip label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} enabled={sidebarCollapsed}><button type="button" aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></SidebarTooltip>
          </div>
        </aside>

        <AnimatePresence>
          {detailPath ? <>
            <motion.button type="button" className="cyber-drawer-backdrop" aria-label="关闭问题详情" onClick={() => setDetailPath(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.aside className="cyber-issue-drawer" style={{ width: `${detailDrawerWidth}px` }} role="dialog" aria-modal="true" aria-label="文件处理详情" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.2 }}>
              <div
                className="issue-drawer-resizer"
                role="separator"
                aria-label="调整详情抽屉宽度"
                aria-orientation="vertical"
                aria-valuemin={currentDetailDrawerBounds.min}
                aria-valuemax={currentDetailDrawerBounds.max}
                aria-valuenow={detailDrawerWidth}
                tabIndex={0}
                onPointerDown={startDetailDrawerResize}
                onKeyDown={resizeDetailDrawerWithKeyboard}
              ><i /></div>
              <header className="issue-drawer-header">
                <div className="issue-header-identity">
                  <FileSpreadsheet />
                  <div>
                    <strong>{fileNameFromPath(detailPath)}</strong>
                    <small title={detailPath}>{detailPath}</small>
                  </div>
                </div>
                <div className="issue-header-actions">
                  <Button type="button" variant="outline" className="issue-open-source" onClick={() => void getDesktopAPI()?.openPath(detailPath)}>
                    <ExternalLink />打开原始文件
                  </Button>
                  {detailResult?.outputPath && tabForStatus(fileStatusByPath[detailPath]) === "success" ? (
                    <Button type="button" variant="outline" className="issue-open-result" onClick={() => void getDesktopAPI()?.openPath(detailResult.outputPath ?? "")}>
                      <FolderOutput />打开结果文件
                    </Button>
                  ) : null}
                  <button type="button" aria-label="关闭文件详情" onClick={() => setDetailPath(null)}><X /></button>
                </div>
              </header>
              <div className="issue-drawer-content" style={{ gridTemplateColumns: `minmax(${DETAIL_PREVIEW_MIN_WIDTH}px, 1fr) ${DETAIL_CONTENT_RESIZER_WIDTH}px ${detailSidebarWidth}px` }}>
                {!detailContentReady ? (
                  <div className="issue-detail-loading" role="status" aria-label="正在准备文件详情">
                    <LoaderCircle />
                    <strong>正在准备文件详情</strong>
                    <small>先打开详情窗口，再加载工作簿与字段映射</small>
                  </div>
                ) : (
                  <>
                <ExcelPreview
                  api={getDesktopAPI()}
                  filePath={detailPath}
                  candidates={detailPreviewCandidates}
                  activeSheetName={detailPreviewSheetName}
                  mapping={detailMapping}
                  singleShipmentMatchingEnabled={detailSingleShipmentMatchingEnabled}
                  matchedOrderRows={detailMatchedOrderRows}
                  writebackRows={detailWritebackRows}
                  onWritebackRowChange={editDetailWritebackRow}
                  onUnmatchedRowConfirm={openSelectedRowDetails}
                  cellEdits={detailPath ? cellEdits[detailPath] ?? [] : []}
                  activeTarget={activeMappingTarget}
                  selectionPrompt={activeMappingTarget ? `正在选择“${mappingTargetLabel(activeMappingTarget)}”` : undefined}
                  onActiveSheetChange={setDetailPreviewSheetName}
                  onWorkbookChange={setDetailPreviewWorkbook}
                  onColumnSelect={selectMappingColumn}
                  onRowSelect={selectMappingRow}
                />
                <div
                  className="issue-content-resizer"
                  role="separator"
                  aria-label="调整预览与字段映射宽度"
                  aria-orientation="vertical"
                  aria-valuemin={currentDetailSidebarBounds.min}
                  aria-valuemax={currentDetailSidebarBounds.max}
                  aria-valuenow={detailSidebarWidth}
                  tabIndex={0}
                  onPointerDown={startDetailSidebarResize}
                  onKeyDown={resizeDetailSidebarWithKeyboard}
                ><i /></div>
                <div className="issue-detail-column">
                  {(() => {
                    const liveValidation = detailValidation.result;
                    const validationErrors = liveValidation?.errors ?? [];
                    const validationMessages = liveValidation
                      ? liveValidation.requestVersion === 0
                        ? validationErrors
                        : [...validationErrors, ...(liveValidation.warnings ?? [])]
                      : [];
                    const uniqueValidationMessages = Array.from(new Set(validationMessages.map((message) => message.trim()).filter(Boolean)));
                    const validationMessageSet = new Set(uniqueValidationMessages);
                    const visibleDecisionReasons = (detailAnalysis?.automationDecision.reasons ?? [])
                      .filter((reason, index, reasons) => (
                        !validationMessageSet.has(reason.trim())
                        && reasons.findIndex((candidate) => candidate.trim() === reason.trim()) === index
                      ));
                    const trialMatched = liveValidation?.matchedRows ?? detailAnalysis?.automationDecision.matchedRows;
                    const trialEvaluated = liveValidation?.evaluatedRows ?? detailAnalysis?.automationDecision.evaluatedRows;
                    const trialCoverage = liveValidation?.coverage ?? detailAnalysis?.automationDecision.coverage;
                    const quantityIssues = detailQuantityIssues;
                    const unmatchedIssues = detailUnmatchedIssues;
                    const trialTone = !liveValidation
                      ? "is-idle"
                      : validationErrors.length
                        ? "is-error"
                        : liveValidation.requestVersion > 0 && (liveValidation.warnings?.length ?? 0) > 0
                          ? "is-warning"
                          : detailValidation.status === "stale"
                            ? "is-stale"
                            : "is-success";
                    const decisionStatus = detailAnalysis?.automationDecision.status;
                    const decisionLabel = decisionStatus === "eligible"
                      ? "可自动"
                      : decisionStatus === "confirm"
                        ? "需确认"
                        : decisionStatus === "error"
                          ? "异常"
                          : "未分析";
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
                            {detailMapping ? (
                              <button
                                type="button"
                                className={`mapping-validation-state is-${detailValidation.status}`}
                                title="字段变更后会自动试算，也可以点击立即试算"
                                disabled={detailValidation.status === "validating"}
                                onClick={() => revalidateMapping(detailPath)}
                              >
                                <RefreshCw />
                                {detailValidation.status === "validating" ? "正在试算" : detailValidation.status === "stale" ? "立即试算" : "重新试算"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                        {detailResult ? (
                          <div className="issue-status-metrics" aria-label="处理结果">
                            <span><b>{detailResult.totalRows ?? 0}</b><em>总行</em></span>
                            <span><b>{detailResult.matchedRows ?? 0}</b><em>匹配</em></span>
                            <span className={(detailResult.exceptionRows ?? 0) > 0 ? "is-alert" : undefined}><b>{detailResult.exceptionRows ?? 0}</b><em>异常</em></span>
                          </div>
                        ) : null}
                        {detailResult?.message ? <p className="issue-status-message">{detailResult.message}</p> : null}
                        {uniqueValidationMessages.length > 0 ? (
                          <div className={`issue-status-messages ${trialTone}`}>
                            {uniqueValidationMessages.map((message) => (
                              <ValidationMessage
                                message={message}
                                quantityIssues={quantityIssues}
                                unmatchedIssues={unmatchedIssues}
                                onOpenUnmatchedDetails={(summary) => openUnmatchedDetails(summary)}
                                key={message}
                              />
                            ))}
                          </div>
                        ) : null}
                        {detailAnalysis && visibleDecisionReasons.length > 0 ? (
                          <ul className="decision-reasons is-compact">
                            {visibleDecisionReasons.map((reason) => (
                              <DecisionReason
                                reason={reason}
                                bestScore={detailAnalysis.automationDecision.candidateScore}
                                runnerUpScore={detailAnalysis.automationDecision.runnerUpScore}
                                scoreKind={detailAnalysis.automationDecision.scoreKind}
                                quantityIssues={quantityIssues}
                                unmatchedIssues={unmatchedIssues}
                                onOpenUnmatchedDetails={(summary) => openUnmatchedDetails(summary)}
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
                          onClose={() => setIssueDetailsRequest(null)}
                        />
                      </section>
                    );
                  })()}
                  {detailAnalysis && detailMapping ? <MappingEditor analysis={detailAnalysis} mapping={detailMapping} workbook={detailPreviewWorkbook} activeTarget={activeMappingTarget} validation={detailValidation} onActiveTargetChange={selectMappingTarget} onMappingChange={(mapping) => commitMapping(detailPath, mapping)} onColumnChange={(target, column, header) => changeMappingColumn(target, column, header)} onSheetChange={(orderSheet, pricingSheet, previewSheet) => { updateMapping(detailPath, orderSheet, pricingSheet); setDetailPreviewSheetName(previewSheet); }} onPreviewSheetChange={setDetailPreviewSheetName} onConfirm={() => void confirmAndContinue(detailPath)} /> : null}
                  {detailPath && fileStatusByPath[detailPath] && tabForStatus(fileStatusByPath[detailPath]) === "error" ? <section className="issue-error-section"><Button type="button" variant="outline" size="sm" onClick={() => void retryAnalysis(detailPath)}><RefreshCw />重新分析此文件</Button></section> : null}
                </div>
                  </>
                )}
              </div>
            </motion.aside>
          </> : null}
        </AnimatePresence>

        <section ref={workspaceRef} className={`cyber-workspace is-${activePage}${activePage === "files" ? batchStarted ? " has-locked-batch" : files.length > 0 ? " has-ready-batch" : " has-empty-batch" : ""}` + (!["workbench", "files", "config", "templates", "logs", "analytics"].includes(activePage) ? " is-coming-soon" : "")}>
          {activePage === "workbench" ? (
            <DashboardPage
              api={getDesktopAPI()}
              dark={theme === "dark"}
              currentFileCount={files.length}
              outputDir={outputDir}
              onNewProcessing={() => { setActivePage("files"); if (!batchStarted) void chooseInputFiles(); }}
              onOpenFiles={() => setActivePage("files")}
              onOpenConfig={() => setActivePage("config")}
            />
          ) : activePage === "files" ? <>
          <AnimatePresence initial={false}>
            {!batchStarted ? <motion.section
              className={`cyber-upload-panel${files.length > 0 ? " is-compact" : " is-expanded"}`}
              aria-labelledby="upload-title"
              key="batch-upload"
              initial={false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.24 }}
            >
              {files.length === 0 ? <>
                <header>
                  <div><span className="panel-icon"><FileBox /></span><h2 id="upload-title">文件处理</h2></div>
                </header>
                <div {...getRootProps({
                  className: "cyber-dropzone" + (isDragActive ? " is-dragging" : ""),
                  onDoubleClick: () => importSourceMode === "file" ? void chooseInputFiles() : void chooseInputDirectory(),
                  onKeyDown: (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (importSourceMode === "file") void chooseInputFiles();
                    else void chooseInputDirectory();
                  },
                })}>
                  <input {...getInputProps()} />
                  <div className="cyber-wave" aria-hidden="true" />
                  <div className="cyber-upload-visual" aria-hidden="true">{importSourceMode === "file" ? <FileUp /> : <FolderOpen />}</div>
                  <strong>{importSourceMode === "file" ? "拖拽一个或多个 Excel 文件到此处" : "拖拽文件夹到此处"}</strong>
                  <span>{importSourceMode === "file" ? "或双击选择本地文件" : "或双击选择本地文件夹"}</span>
                  <small>{importSourceMode === "file" ? "支持格式：.xlsx、.xls、.xlsm、.xlsb" : "将自动扫描文件夹中的 Excel 文件"}</small>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={importSourceMode === "folder"}
                    aria-label={`导入模式：${importSourceMode === "file" ? "单文件" : "文件夹"}`}
                    className={`cyber-import-switch is-${importSourceMode}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setImportSourceMode((current) => current === "file" ? "folder" : "file");
                    }}
                  >
                    <span>单文件</span><i aria-hidden="true" /><span>文件夹</span>
                  </button>
                </div>
              </> : <div {...getRootProps({ className: `cyber-upload-banner${isDragActive ? " is-dragging" : ""}` })}>
                <input {...getInputProps()} />
                <div className="cyber-upload-summary">
                  <span className="panel-icon"><FileCheck2 /></span>
                  <div><strong id="upload-title">已导入 {files.length} 个文件</strong><small>可继续拖入{importSourceMode === "file" ? "一个或多个 Excel 文件" : "一个文件夹"}</small></div>
                </div>
                <div className="cyber-pipeline" aria-label="自动处理流程">
                  <span className="is-done"><b>1</b>导入<em>{files.length}</em></span>
                  <span><b>2</b>分析</span>
                  <span><b>3</b>确认</span>
                  <span><b>4</b>核价</span>
                  <span><b>5</b>完成</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={importSourceMode === "folder"}
                  aria-label={`导入模式：${importSourceMode === "file" ? "单文件" : "文件夹"}`}
                  className={`cyber-import-switch is-${importSourceMode}`}
                  onClick={() => setImportSourceMode((current) => current === "file" ? "folder" : "file")}
                >
                  <span>单文件</span><i aria-hidden="true" /><span>文件夹</span>
                </button>
                <button type="button" className="cyber-continue-import" onClick={() => importSourceMode === "file" ? void chooseInputFiles() : void chooseInputDirectory()}><FilePlus2 />继续添加</button>
                {!sidebarCollapsed ? renderTaskActions("cyber-workbench-actions cyber-banner-actions", true) : null}
              </div>}
            </motion.section> : null}
          </AnimatePresence>

          <section className="cyber-table-panel">
            <header className="cyber-table-toolbar">
              <div className="cyber-file-list-title">
                <h2>文件列表 <span>（{visibleFiles.length}）</span></h2>
                {files.length > 0 ? (
                  <div className="cyber-batch-name" title={batchId ? `批次 ID：${batchId}` : "开始核价后写入日志中心"}>
                    <small>当前批次</small>
                    {editingBatchName ? (
                      <input
                        autoFocus
                        value={batchName}
                        maxLength={120}
                        aria-label="批次名称"
                        onChange={(event) => setBatchName(event.target.value)}
                        onBlur={() => void commitBatchName()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            setBatchName(defaultDraftBatchName(files, importSourceMode));
                            setEditingBatchName(false);
                          }
                        }}
                      />
                    ) : (
                      <button type="button" onClick={() => setEditingBatchName(true)} aria-label="编辑批次名称">
                        <span data-name={batchName || defaultDraftBatchName(files, importSourceMode)} /><Pencil />
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
              {files.length > 0 ? <div className="cyber-table-actions">
                <div className="cyber-tabs" aria-label="文件状态统计">
                  {fileTabs.map((tab) => (
                    <button
                      type="button"
                      className={activeTab === tab.key ? "is-active" : ""}
                      key={tab.key}
                      onClick={() => {
                        userTabLockedRef.current = true;
                        setActiveTab(tab.key);
                      }}
                    >
                      {tab.label}<b>{tabCounts[tab.key]}</b>
                    </button>
                  ))}
                </div>
                <details className="cyber-column-manager">
                  <summary aria-label="列管理"><Settings2 /></summary>
                  <div>{fileTable.getAllLeafColumns().filter((column) => column.getCanHide()).map((column) => <label key={column.id}><Checkbox checked={column.getIsVisible()} onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))} />{String(column.columnDef.header)}</label>)}</div>
                </details>
              </div> : null}
            </header>

            <AnimatePresence initial={false}>
              {batchStarted ? <motion.div className={`cyber-batch-progress${isTaskActive ? " is-running" : " is-settled"}`} aria-label="批次处理进度" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 58 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.24 }}>
                <div className="cyber-batch-progress-copy"><span className="cyber-batch-phase"><i />{batchPhaseLabel}</span><strong>{progressPercent}%</strong></div>
                <Progress value={progressPercent} role="progressbar" aria-label={`${batchPhaseLabel} ${progressPercent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} />
                <small className="cyber-batch-file">{progress.current}/{progress.total || files.length} 个文件{activePath ? ` · ${fileNameFromPath(activePath)}` : ""}</small>
                {!sidebarCollapsed ? renderTaskActions("cyber-workbench-actions cyber-progress-actions", true, true) : null}
              </motion.div> : null}
            </AnimatePresence>

            <div className={`cyber-table-scroll${hasTableRows ? "" : " is-empty"}`} ref={tableScrollRef}>
              <table className={`cyber-file-table is-${activeTab}`} style={{ "--cyber-table-width": `${fileTable.getTotalSize()}px` } as CSSProperties}>
                <colgroup>{visibleFileColumns.map((column) => <col key={column.id} className={column.id === "select" ? "checkbox-column" : column.id === "index" ? "index-column" : column.id === "actions" ? "action-column" : undefined} style={{ width: `${column.getSize()}px` }} />)}</colgroup>
                <thead><tr>{visibleFileHeaders.map((header) => {
                  const column = header.column;
                  const className = `${column.id === "select" ? "checkbox-column" : column.id === "index" ? "index-column" : column.id === "actions" ? "action-column" : ""}${column.getIsPinned() ? " is-pinned-column" : ""}`.trim() || undefined;
                  return <th key={header.id} className={className} style={filePinnedStyle(column, true)}>
                    {column.id === "select" ? <Checkbox checked={selectedAll} onCheckedChange={() => toggleAllSelected()} aria-label="全选当前状态文件" /> : <button type="button" disabled={!column.getCanSort()} onClick={column.getToggleSortingHandler()}>{String(column.columnDef.header)}{column.getCanSort() ? <ArrowUpDown /> : null}</button>}
                    {column.getCanPin() ? <button type="button" className="table-column-pin" aria-label={`${column.getIsPinned() ? "取消冻结" : "冻结"} ${String(column.columnDef.header)} 列`} title={column.getIsPinned() ? "取消冻结列" : "冻结到左侧"} onClick={() => toggleFileColumnPin(column.id)}>{column.getIsPinned() ? <PinOff /> : <Pin />}</button> : null}
                    {hasTableRows && column.getCanResize() ? <div className={`column-resizer${column.getIsResizing() ? " is-resizing" : ""}`} role="separator" tabIndex={0} title="拖动调整列宽，双击恢复默认" aria-label={`调整 ${String(column.columnDef.header)} 列宽`} aria-orientation="vertical" aria-valuemin={column.columnDef.minSize ?? 80} aria-valuemax={column.columnDef.maxSize ?? 560} aria-valuenow={header.getSize()} onDoubleClick={() => column.resetSize()} onMouseDown={header.getResizeHandler()} onTouchStart={header.getResizeHandler()} onKeyDown={(event) => {
                      const delta = event.key === "ArrowLeft" ? -8 : event.key === "ArrowRight" ? 8 : 0;
                      if (!delta) return;
                      event.preventDefault();
                      const minSize = column.columnDef.minSize ?? 80;
                      const maxSize = column.columnDef.maxSize ?? 560;
                      setColumnSizing((current) => ({ ...current, [column.id]: Math.min(maxSize, Math.max(minSize, header.getSize() + delta)) }));
                    }} /> : null}
                  </th>;
                })}</tr></thead>
                <tbody style={shouldVirtualizeRows ? { height: rowVirtualizer.getTotalSize(), position: "relative" } : undefined}>
                  {renderedTableRows.map(({ row, virtualRow }) => {
                    const path = row.original;
                    const analysis = analyses[path];
                    const result = results[path];
                    const currentMapping = mappings[path] ?? analysis?.suggestedMapping ?? null;
                    const status = fileStatusByPath[path];
                    return <Fragment key={path}>
                      <tr ref={virtualRow ? rowVirtualizer.measureElement : undefined} data-index={virtualRow?.index} data-file-path={path} className={`${selectedSet.has(path) ? "is-selected" : ""}${highlightedResultPath === path ? " is-result-revealed" : ""}`.trim()} style={virtualRow ? { position: "absolute", transform: `translateY(${virtualRow.start}px)`, width: "100%", display: "table", tableLayout: "fixed" } : undefined}>
                        {[...row.getLeftVisibleCells(), ...row.getCenterVisibleCells(), ...row.getRightVisibleCells()].map((cell) => {
                          const pinnedClass = cell.column.getIsPinned() ? " is-pinned-column" : "";
                          const pinnedStyle = filePinnedStyle(cell.column);
                          if (cell.column.id === "select") return <td key={cell.id} className={`checkbox-column${pinnedClass}`} style={pinnedStyle}><Checkbox checked={selectedSet.has(path)} onCheckedChange={() => toggleSelected(path)} aria-label={"选择 " + fileNameFromPath(path)} /></td>;
                          if (cell.column.id === "index") return <td key={cell.id} className={`index-column${pinnedClass}`} style={pinnedStyle}>{files.indexOf(path) + 1}</td>;
                           if (cell.column.id === "fileName") return <td key={cell.id} className={`file-cell${pinnedClass}`} style={pinnedStyle}><FileSpreadsheet /><button type="button" onClick={() => void openSourceDirectory(path)} title={path}>{fileNameFromPath(path)}</button></td>;
                           if (cell.column.id === "orderSheet") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{currentMapping?.orderSheet ?? "—"}</td>;
                           if (cell.column.id === "pricingSheet") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{currentMapping?.pricingSheet ?? "—"}</td>;
                           if (cell.column.id === "coverage") { const value = result?.coverage ?? analysis?.coverage; return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{value === undefined ? "—" : <div className="coverage-cell"><Progress value={value * 100} /><span>{formatCoverage(value)}</span></div>}</td>; }
                           if (cell.column.id === "importMode") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{importModes[path] === "folder" ? "文件夹" : importModes[path] === "config" ? "配置目录" : "文件"}</td>;
                           if (cell.column.id === "status") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}><span className={"cyber-status is-" + statusMeta[status].tone}><i />{statusMeta[status].label}</span>{result?.status === "completed" ? <small>{result.matchedRows ?? 0}/{result.totalRows ?? 0} 行</small> : null}</td>;
                           if (cell.column.id === "createdAt") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{importedAt[path] ?? "—"}</td>;
                           if (cell.column.id === "evidence") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{analysis?.automationDecision.evaluatedRows ?? 0} 行</td>;
                           if (cell.column.id === "issue") { const issue = result?.status === "completed" && (result.exceptionRows ?? 0) > 0 ? `${result.exceptionRows} 行存在异常` : result?.message ?? analysis?.automationDecision.reasons[0] ?? analysis?.issues[0] ?? "—"; return <td key={cell.id} className={`issue-cell${pinnedClass}`} style={pinnedStyle} title={issue}>{issue}</td>; }
                           if (cell.column.id === "rows") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{result ? `${result.matchedRows ?? 0}/${result.totalRows ?? 0}` : "—"}</td>;
                           if (cell.column.id === "completedAt") return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{result?.completedAt ?? importedAt[path] ?? "—"}</td>;
                           return <td key={cell.id} className={`action-column${pinnedClass}`} style={pinnedStyle}><button type="button" onClick={() => openDetailDrawer(path)}>详情</button>{activeTab === "success" && result?.outputPath ? <button type="button" onClick={() => void getDesktopAPI()?.openPath(result.outputPath ?? "")}>打开</button> : null}{activeTab === "pending" ? <button type="button" disabled={isAnalyzing || isRunning} onClick={() => removeFile(path)} aria-label={"移除 " + fileNameFromPath(path)}><X /></button> : null}</td>;
                        })}
                      </tr>
                    </Fragment>;
                  })}
                </tbody>
              </table>
              {!hasTableRows ? (
                <div className="cyber-empty cyber-empty-overlay">
                  <div className="cyber-empty-visual" aria-hidden="true"><Inbox /></div>
                  <strong>{listEmptyState.title}</strong>
                  <span>{listEmptyState.detail}</span>
                  {listEmptyState.action ? (
                    <button type="button" className="cyber-empty-action" onClick={listEmptyState.action.onClick}>
                      {listEmptyState.action.label}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <footer className="cyber-pagination" aria-label="分页">
              <div className="cyber-pagination-info">
                {visibleFiles.length === 0
                  ? "共 0 条"
                  : `共 ${visibleFiles.length} 条 · 第 ${pageIndex * pageSize + 1}–${Math.min((pageIndex + 1) * pageSize, visibleFiles.length)} 条`}
              </div>
              <div className="cyber-pagination-nav" role="navigation" aria-label="页码">
                <button type="button" aria-label="上一页" disabled={pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>
                  <ChevronLeft />
                </button>
                <span className="cyber-pagination-page" aria-current="page">
                  {pageIndex + 1}<em>/</em>{pageCount}
                </span>
                <button type="button" aria-label="下一页" disabled={pageIndex + 1 >= pageCount} onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}>
                  <ChevronRight />
                </button>
              </div>
              <div className="cyber-pagination-size">
                <span>每页</span>
                <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                  <SelectTrigger className="pagination-size-select" aria-label="每页条数"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[50, 100, 200, 500, 1000].map((size) => <SelectItem value={String(size)} key={size}>{size} 条</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </footer>
          </section>
          </> : activePage === "config" ? (
            <ConfigCenterPage
              api={getDesktopAPI()}
              onDocumentSaved={handleConfigDocumentSaved}
              onAppSettingsChanged={handleAppSettingsChanged}
            />
          ) : activePage === "templates" ? (
            <TemplateManagementPage api={getDesktopAPI()} />
          ) : activePage === "logs" ? (
            <LogCenterPage
              api={getDesktopAPI()}
              revision={historyRevision}
              requestedBatchId={requestedHistoryBatchId}
              onRequestedBatchHandled={() => setRequestedHistoryBatchId(null)}
            />
          ) : activePage === "analytics" ? (
            <AnalyticsPage
              api={getDesktopAPI()}
              dark={theme === "dark"}
              revision={historyRevision}
              onOpenBatch={(batchId) => {
                setRequestedHistoryBatchId(batchId);
                setActivePage("logs");
              }}
            />
          ) : (
            <section className="coming-soon-page" aria-labelledby="coming-soon-title">
              <div className="coming-soon-icon" aria-hidden="true"><ActiveNavigationIcon /></div>
              <span className="coming-soon-eyebrow">{activeNavigationItem.label}</span>
              <h1 id="coming-soon-title">正在装修中</h1>
              <p>该功能页面正在设计和开发，后续版本将逐步开放。</p>
              <Button type="button" className="coming-soon-back" onClick={() => setActivePage("workbench")}><LayoutDashboard />返回工作台</Button>
            </section>
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
          description={`当前仍有 ${tabCounts.confirm} 个待确认、${tabCounts.error} 个异常、${tabCounts.pending} 个未完成文件。结束后，所有没有有效核价结果的文件将复制到当前批次结果目录的“未处理”文件夹，原始文件保持不变。`}
          confirmLabel="结束并归档"
          onCancel={() => setNextBatchConfirmOpen(false)}
          onConfirm={() => {
            setNextBatchConfirmOpen(false);
            void chooseNextBatch();
          }}
        />
      </main>
    </MotionConfig>
    </TooltipProvider>
  );

  return (
    <MotionConfig reducedMotion="user">
    <main className="app-shell" ref={shellRef}>
      <Toaster
        className="cyber-toaster"
        position="top-left"
        closeButton
        expand
        visibleToasts={5}
        theme={theme}
        duration={1_000}
        gap={8}
        offset={16}
        toastOptions={{
          classNames: {
            toast: "cyber-toast",
            title: "cyber-toast-title",
            icon: "cyber-toast-icon",
            closeButton: "cyber-toast-close",
          },
        }}
      />
      <aside className="left-rail">
        <section className="operation-panel" aria-labelledby="operation-title">
          <div className="section-heading">
            <div><span className="section-icon"><Settings2 size={15} /></span><h2 id="operation-title">操作面板</h2></div>
            <span>文件与任务</span>
          </div>
          <div className="rail-toolbar" aria-label="路径与配置操作">
            <IconAction icon={FolderOpen} label="目标文件夹" onClick={() => void chooseInputDirectory()} disabled={isAnalyzing || isRunning} />
            <IconAction icon={FolderOutput} label="输出文件夹" onClick={() => void chooseOutputDirectory()} />
            <IconAction icon={Settings2} label="选择配置文件" onClick={() => void chooseConfigFile()} disabled={isAnalyzing || isRunning} />
            <IconAction icon={FileSpreadsheet} label="当前配置文件" onClick={() => void openCurrentConfig()} disabled={!configPath} />
          </div>
          <div className="rail-toolbar rail-toolbar-secondary" aria-label="任务控制">
            <IconAction icon={ScanSearch} label="扫描" onClick={() => void scanFiles()} disabled={isAnalyzing || isRunning} active={isAnalyzing} tone={isAnalyzing ? "primary" : "normal"} />
            <IconAction icon={Play} label="处理" onClick={() => void runPricing()} disabled={isAnalyzing || isRunning || actionFiles.length === 0} active={isRunning} tone={isRunning ? "primary" : "normal"} />
            <IconAction icon={RefreshCw} label="重置本批" onClick={requestResetTask} />
          </div>
          <div className="pinned-paths">
            <div className="pinned-path"><span>目标</span><code title={inputDir}>{inputDir || "未选择输入文件夹"}</code></div>
            <div className="pinned-path"><span>输出</span><code title={outputDir}>{outputDir || "未选择输出文件夹"}</code></div>
            <div className="pinned-path"><span>配置</span><code title={configPath}>{configPath || "内置配置"}</code></div>
          </div>
        </section>

        <section className="log-panel" aria-label="运行日志">
          <div className="log-header">
            <div>
              <h2>运行日志</h2>
              <span>{logs.length} 条记录</span>
            </div>
            <div className="log-header-actions">
              <span className={isAnalyzing || isRunning ? "run-pill is-running" : "run-pill"}>{isPaused ? "处理中" : isAnalyzing ? "分析中" : isRunning ? "核价中" : "待处理"}</span>
              <IconAction icon={Download} label="导出日志" onClick={() => void exportLogs()} compact />
              <IconAction icon={Trash2} label="清空日志" onClick={() => setLogs([])} compact />
            </div>
          </div>
          <div className="log-list" role="log" aria-live="polite">
            {logs.length === 0 ? <div className="log-empty">等待文件导入和核价日志</div> : null}
            {logs.map((log) => (
              <div className={"log-row is-" + log.level} key={log.id} title={log.message}>
                <time>{log.time}</time>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
          <div className="dot-progress-panel">
            <div className="dot-progress-heading">
              <div className="progress-ring" aria-label={"总体进度 " + progressPercent + "%"}><ProgressChart value={progressPercent} /><div><strong>{progressPercent}%</strong><span>总进度</span></div></div>
              <span>处理进度</span>
              <strong>{completedDotCount}/{files.length}</strong>
            </div>
            <div className="dot-grid" role="list" aria-label="文件点阵进度">
              {progressDots.length === 0 ? <span className="dot-empty">导入文件后显示点阵</span> : null}
              {progressDots.map((dot, index) => (
                <span
                  className={"progress-dot is-" + dot.status + (dot.status === "running" && isPaused ? " is-paused" : "")}
                  key={dot.path}
                  role="listitem"
                  title={index + 1 + ". " + dot.label + "：" + dotStatusLabels[dot.status]}
                />
              ))}
            </div>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <div className="workspace-heading">
          <div className="metric-grid" aria-label="任务统计">
            <motion.div className="metric-card is-progress" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}><span>总进度</span><strong>{progressPercent}%</strong><Progress value={progressPercent} /><small>{phaseLabel}</small></motion.div>
            <motion.div className="metric-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}><span>文件数</span><strong>{files.length}</strong><small>已选 {selectedPaths.length}</small></motion.div>
            <motion.div className="metric-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.08 }}><span>处理完成</span><strong>{completedDotCount}</strong><small>共 {files.length} 个</small></motion.div>
            <motion.div className="metric-card is-success" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.12 }}><span>匹配成功率</span><strong>{matchedRate}</strong><small>{totalMatched}/{totalRows} 行</small></motion.div>
          </div>
          <Button type="button" variant="outline" size="icon" className="theme-toggle" onClick={toggleTheme} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
        </div>

        <section className="file-processing-panel" aria-labelledby="file-processing-title">
          <div className="panel-title-row">
            <div><span className="section-icon"><FileSpreadsheet size={15} /></span><h2 id="file-processing-title">文件处理</h2></div>
            <span>{activePath ? "正在处理：" + fileNameFromPath(activePath) : "原始 Excel 不会被覆盖"}</span>
          </div>
          <div {...getRootProps({ className: "drop-zone import-strip" + (isDragActive ? " is-dragging" : "") })}>
          <div className="import-icon"><FilePlus2 size={18} strokeWidth={1.8} /></div>
          <div className="import-copy">
            <strong>导入或拖入 Excel 文件</strong>
            <span>支持 xlsx、xlsm、xlsb、xls，选择目标文件夹后点击“扫描文件”</span>
          </div>
          <span className="import-count">{files.length} 个文件</span>
          </div>
        </section>

        <div className="table-panel">
          <div className="table-toolbar">
            <div className="table-title"><strong>{files.length} 个文件，当前显示 {visibleFiles.length} 个，已选 {selectedPaths.length} 个</strong><span>{activePath ? "正在处理：" + fileNameFromPath(activePath) : "原始 Excel 不会被覆盖"}</span></div>
            <div className="toolbar-right">
            <details className="column-manager">
              <summary><Columns3 size={15} />列管理</summary>
              <div className="column-menu">
                {fileTable.getAllLeafColumns().filter((column) => column.getCanHide()).map((column) => (
                  <label key={column.id}><Checkbox checked={column.getIsVisible()} onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))} />{String(column.columnDef.header)}</label>
                ))}
              </div>
            </details>
            <div className="status-tabs" aria-label="文件状态统计">
              {fileTabs.map((tab) => (
                <button
                  type="button"
                  className={"status-tab" + (activeTab === tab.key ? " is-active" : "")}
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span>{tab.label}</span>
                  <strong>{tabCounts[tab.key]}</strong>
                </button>
              ))}
            </div>
            </div>
          </div>
          <div className="table-scroll" ref={tableScrollRef}>
            <table className="file-table">
              <thead>
                <tr>
                  {fileTable.getVisibleLeafColumns().map((column) => (
                    <th key={column.id} className={column.id === "select" ? "checkbox-column" : column.id === "index" ? "index-column" : column.id === "actions" ? "action-column" : undefined}>
                      {column.id === "select" ? <Checkbox checked={selectedAll} onCheckedChange={() => toggleAllSelected()} aria-label="全选当前 Tab 文件" /> : (
                        <button type="button" className="sortable-header" disabled={!column.getCanSort()} onClick={column.getToggleSortingHandler()}>
                          {String(column.columnDef.header)}{column.getCanSort() ? <ArrowUpDown size={13} /> : null}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody style={shouldVirtualizeRows ? { height: rowVirtualizer.getTotalSize(), position: "relative" } : undefined}>
                {visibleFiles.length === 0 ? (
                  <tr><td colSpan={fileTable.getVisibleLeafColumns().length}><div className="table-empty"><FileSpreadsheet size={30} strokeWidth={1.5} /><strong>{files.length === 0 ? "暂无 Excel 文件" : fileTabs.find((tab) => tab.key === activeTab)?.label + "暂无文件"}</strong><span>{files.length === 0 ? "把 Excel 文件拖入上方区域，或选择目标文件夹后点击扫描" : "切换其他 Tab 查看当前任务"}</span></div></td></tr>
                ) : null}
                {renderedTableRows.map(({ row, virtualRow }) => {
                  const path = row.original;
                  const index = files.indexOf(path);
                  const analysis = analyses[path];
                  const result = results[path];
                  const currentMapping = mappings[path] ?? analysis?.suggestedMapping ?? null;
                  const status = fileStatusByPath[path];
                  const isExpanded = expandedPath === path;
                  return (
                    <Fragment key={path}>
                      <tr ref={virtualRow ? rowVirtualizer.measureElement : undefined} data-index={virtualRow?.index} className={"file-row is-" + status + (selectedSet.has(path) ? " is-selected" : "")} style={virtualRow ? { position: "absolute", transform: `translateY(${virtualRow.start}px)`, width: "100%", display: "table", tableLayout: "fixed" } : undefined}>
                        {row.getVisibleCells().map((cell) => {
                          if (cell.column.id === "select") return <td key={cell.id} className="checkbox-column"><Checkbox checked={selectedSet.has(path)} onCheckedChange={() => toggleSelected(path)} aria-label={"选择 " + fileNameFromPath(path)} /></td>;
                          if (cell.column.id === "index") return <td key={cell.id} className="index-column">{index + 1}</td>;
                          if (cell.column.id === "fileName") return <td key={cell.id} className="file-name-cell">
                          <FileSpreadsheet size={17} strokeWidth={1.7} />
                          <button type="button" className="file-name-button" onClick={() => void openSourceDirectory(path)} title={path}>
                            <strong>{fileNameFromPath(path)}</strong>
                            <span>{path}</span>
                          </button>
                          </td>;
                          if (cell.column.id === "orderSheet") return <td key={cell.id}>{currentMapping?.orderSheet ?? "—"}</td>;
                          if (cell.column.id === "pricingSheet") return <td key={cell.id}>{currentMapping?.pricingSheet ?? "—"}</td>;
                          if (cell.column.id === "coverage") return <td key={cell.id}><span className={analysis && analysis.coverage >= 0.95 ? "coverage-label is-good" : analysis ? "coverage-label is-warning" : "coverage-label"}>{analysis ? "覆盖率 " + formatCoverage(analysis.coverage) : "—"}</span></td>;
                          if (cell.column.id === "status") return <td key={cell.id}><Badge variant="outline" className={"table-status is-" + statusMeta[status].tone}><span className="status-dot" />{statusMeta[status].label}</Badge>{result?.status === "completed" ? <small className="status-count">{result.matchedRows ?? 0}/{result.totalRows ?? 0} 行已核价</small> : null}</td>;
                           return <td key={cell.id} className="action-column"><button type="button" className="row-action" onClick={() => setExpandedPath(isExpanded ? null : path)}>{isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}字段</button>{activeTab === "success" && result?.outputPath ? <button type="button" className="row-link" onClick={() => void getDesktopAPI()?.openPath(result.outputPath ?? "")}>打开</button> : null}<button type="button" className="row-remove" disabled={isAnalyzing || isRunning} onClick={() => removeFile(path)} aria-label={"移除 " + fileNameFromPath(path)}><X size={15} /></button></td>;
                        })}
                      </tr>
                      {isExpanded ? (
                        <tr className="detail-row" key={path + "-detail"}><td colSpan={fileTable.getVisibleLeafColumns().length}><div className="detail-panel">
                          {analysis ? (
                            <>
                              <div className="detail-grid">
                                <label>订单 Sheet<Select value={currentMapping?.orderSheet ?? ""} onValueChange={(value) => updateMapping(path, value, currentMapping?.pricingSheet ?? "")}><SelectTrigger aria-label="订单 Sheet"><SelectValue /></SelectTrigger><SelectContent>{analysis.orderSheetCandidates.map((candidate) => <SelectItem value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.validOrderRows ?? 0} 行</SelectItem>)}</SelectContent></Select></label>
                                <label>核价 Sheet<Select value={currentMapping?.pricingSheet ?? ""} onValueChange={(value) => updateMapping(path, currentMapping?.orderSheet ?? "", value)}><SelectTrigger aria-label="核价 Sheet"><SelectValue /></SelectTrigger><SelectContent>{analysis.pricingSheetCandidates.map((candidate) => <SelectItem value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.validPriceRows ?? 0} 行</SelectItem>)}</SelectContent></Select></label>
                              </div>
                              {currentMapping ? <div className="mapping-line"><span>表头：订单第 {currentMapping.orderHeaderRow} 行 / 核价第 {currentMapping.pricingHeaderRow} 行</span><span>订单号：{columnLabel(currentMapping.businessOrderNumberColumn)}</span><span>国家：{columnLabel(currentMapping.countryCodeColumn)} + {columnLabel(currentMapping.countryEnglishColumn)} + {columnLabel(currentMapping.countryChineseColumn)}</span><span>数量/SKU/合并数量：{currentMapping.skuQtyPairs.map((pair) => pair.qtyColumn + "/" + pair.skuColumn + "/" + pair.mergedQtyColumn).join("、") || "未识别"}</span><span>数量档位：{currentMapping.quantityTierColumns.map((tier) => tier.quantity).join("、") || "未识别"}</span></div> : null}
                              {analysis.issues.length > 0 ? <ul className="detail-issues">{analysis.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
                            </>
                          ) : <div className="detail-empty">尚未分析此文件</div>}
                        </div></td></tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <footer className="global-footer">
        <div className="footer-statuses">
          {fileTabs.map((tab) => {
            const dotClass = tab.key === "confirm" ? "ready" : tab.key;
            return <span key={tab.key}><i className={"legend-dot is-" + dotClass} />{tab.label} <strong>{tabCounts[tab.key]}</strong></span>;
          })}
        </div>
        <div className="footer-summary"><strong>{completedDotCount}/{files.length} 个文件</strong><span>已核价 {totalMatched}/{totalRows} 行</span><span>已选 {selectedPaths.length} 个</span></div>
      </footer>
    </main>
    </MotionConfig>
  );
}
