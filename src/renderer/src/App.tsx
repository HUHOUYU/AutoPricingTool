import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ColumnDef, type SortingState, type VisibilityState, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
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
import { useDropzone } from "react-dropzone";
import { toast, Toaster } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ProgressChart } from "@/components/progress-chart";
import { ConfigCenterPage } from "@/components/config-center-page";
import { DashboardPage } from "@/components/dashboard-page";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useUIStore, type FileTab, type WorkbenchPage } from "@/stores/ui-store";
import type {
  DesktopAPI,
  PriceAnalysisCandidate,
  PriceAnalysisFile,
  PriceCheckMapping,
  ProcessorEvent,
  RuntimeConfig,
} from "../../preload";

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

type ImportSummary = {
  imported: number;
  duplicates: number;
};

type LogEntry = {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
};

type FileStatus = "pending" | "running" | "ready" | "success" | "warning" | "error";
type DotStatus = FileStatus;

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
  { key: "config", label: "配置中心", icon: Settings2 },
  { key: "rules", label: "规则管理", icon: Workflow },
  { key: "templates", label: "模板管理", icon: FileCog },
  { key: "logs", label: "日志中心", icon: FileClock },
  { key: "analytics", label: "数据统计", icon: BarChart3 },
];

const MAX_INPUT_FILES = 5_000;

function getDesktopAPI(): DesktopAPI | null {
  return window.desktopAPI ?? null;
}

function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function isExcelFile(file: File): boolean {
  return /\.(xlsx|xlsm|xlsb|xls)$/i.test(file.name);
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function buildMapping(order: PriceAnalysisCandidate, pricing: PriceAnalysisCandidate): PriceCheckMapping {
  return {
    orderSheet: order.sheetName,
    orderHeaderRow: order.headerRow,
    businessOrderNumberColumn: order.businessOrderNumberColumn ?? null,
    platformOrderNumberColumn: order.platformOrderNumberColumn ?? null,
    countryCodeColumn: order.countryCodeColumn ?? null,
    countryEnglishColumn: order.countryEnglishColumn ?? null,
    countryChineseColumn: order.countryChineseColumn ?? null,
    skuQtyPairs: order.skuQtyPairs ?? [],
    shippingMethodColumn: order.shippingMethodColumn ?? null,
    orderPriceColumn: order.priceColumn ?? null,
    pricingSheet: pricing.sheetName,
    pricingHeaderRow: pricing.headerRow,
    pricingQuantityHeaderRow: pricing.quantityHeaderRow ?? null,
    pricingSkuColumn: pricing.skuColumn ?? 1,
    pricingCountryColumn: pricing.countryColumn ?? 1,
    pricingShippingMethodColumn: pricing.shippingMethodColumn ?? null,
    quantityTierColumns: pricing.tierColumns ?? [],
  };
}

function formatCoverage(value: number | undefined): string {
  return String(((value ?? 0) * 100).toFixed(1)) + "%";
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

function columnLabel(value: number | null | undefined): string {
  return value ? "第 " + value + " 列" : "未识别";
}

function statusForFile(
  path: string,
  analysis: PriceAnalysisFile | undefined,
  result: FileResult | undefined,
  activePath: string,
  isBusy: boolean,
): FileStatus {
  if (result?.status === "failed") return "error";
  if (result?.status === "completed") return (result.exceptionRows ?? 0) > 0 ? "warning" : "success";
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
    (mapping.businessOrderNumberColumn || mapping.platformOrderNumberColumn) &&
    (mapping.countryCodeColumn || mapping.countryEnglishColumn || mapping.countryChineseColumn) &&
    mapping.skuQtyPairs.length > 0 &&
    mapping.pricingSkuColumn > 0 &&
    mapping.pricingCountryColumn > 0 &&
    mapping.quantityTierColumns.length > 0 &&
    mapping.orderSheet !== mapping.pricingSheet,
  );
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
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const logDrawerCloseRef = useRef<HTMLButtonElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, PriceAnalysisFile>>({});
  const [mappings, setMappings] = useState<Record<string, PriceCheckMapping>>({});
  const [results, setResults] = useState<Record<string, FileResult>>({});
  const [inputDir, setInputDir] = useState("");
  const [inputDirectorySelected, setInputDirectorySelected] = useState(false);
  const [outputDir, setOutputDir] = useState("");
  const [configPath, setConfigPath] = useState("");
  const { activeTab, setActiveTab, activePage, setActivePage, theme, toggleTheme, sidebarCollapsed, toggleSidebar } = useUIStore();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [importedAt, setImportedAt] = useState<Record<string, string>>({});
  const [importModes, setImportModes] = useState<Record<string, ImportMode>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [activePath, setActivePath] = useState("");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: "", path: "" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState(false);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [analysisCompletedToken, setAnalysisCompletedToken] = useState(0);
  const analysesRef = useRef<Record<string, PriceAnalysisFile>>({});
  const mappingsRef = useRef<Record<string, PriceCheckMapping>>({});
  const confirmedPathsRef = useRef<Set<string>>(new Set());
  const autoRunRequestedRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (!isLogDrawerOpen) return;
    logDrawerCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setIsLogDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isLogDrawerOpen]);

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

  useEffect(() => {
    const api = getDesktopAPI();
    if (!api) {
      appendLog("Electron 接口未加载，请从桌面应用启动", "error");
      return undefined;
    }
    let active = true;
    void api
      .getRuntimeConfig()
      .then((config: RuntimeConfig) => {
        if (!active) return;
        setInputDir(config.recent_input_dir ?? "");
        setOutputDir(config.recent_output_dir ?? "");
        setConfigPath(config.recent_config_path ?? "");
      })
      .catch((error: unknown) => appendLog("读取运行配置失败：" + String(error), "warning"));
    return () => {
      active = false;
    };
  }, [appendLog]);

  const handleProcessorEvent = useCallback(
    (event: ProcessorEvent): void => {
      if (event.type === "price-analysis" || event.type === "price-mapping-required") {
        const analysis = event.file;
        const nextAnalyses = { ...analysesRef.current, [analysis.inputPath]: analysis };
        analysesRef.current = nextAnalyses;
        setAnalyses(nextAnalyses);
        if (analysis.suggestedMapping) {
          const nextMappings = {
            ...mappingsRef.current,
            [analysis.inputPath]: analysis.suggestedMapping as PriceCheckMapping,
          };
          mappingsRef.current = nextMappings;
          setMappings(nextMappings);
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
      if (event.type === "price-progress") {
        setActivePath(event.path);
        setProgress({ current: event.current, total: event.total, phase: event.phase, path: event.path });
        return;
      }
      if (event.type === "price-file-result") {
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
        setResults((current) => ({ ...current, [event.path]: result }));
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
        setActivePath("");
        if (event.mode === "analysis") {
          setIsAnalyzing(false);
          appendLog(event.stopped ? "分析已停止" : "分析完成，请检查待确认文件", event.stopped ? "warning" : "success");
          if (!event.stopped) setAnalysisCompletedToken((current) => current + 1);
        } else {
          setIsRunning(false);
          setIsPaused(false);
          appendLog(event.stopped ? "核价已停止" : "核价完成", event.stopped ? "warning" : "success");
          if (!event.stopped) {
            const completedCount = event.files.filter((item) => Number(item.exceptionRows ?? 0) === 0).length;
            const exceptionCount = event.files.filter((item) => Number(item.exceptionRows ?? 0) > 0).length + (event.failures?.length ?? 0);
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
        setIsAnalyzing(false);
        setIsRunning(false);
        setIsPaused(false);
        setActivePath("");
        appendLog(event.userMessage ?? event.message, "error");
      }
    },
    [appendLog],
  );

  useEffect(() => {
    const api = getDesktopAPI();
    return api?.onProcessorEvent(handleProcessorEvent);
  }, [handleProcessorEvent]);

  const registerPaths = useCallback((paths: string[], mode: ImportMode): ImportSummary => {
    const existingKeys = new Set(files.map((path) => path.toLocaleLowerCase()));
    const uniqueIncoming = Array.from(new Map(paths.map((path) => [path.toLocaleLowerCase(), path])).values());
    const newPaths = uniqueIncoming.filter((path) => !existingKeys.has(path.toLocaleLowerCase()));
    const duplicateCount = paths.length - newPaths.length;
    if (newPaths.length === 0) {
      toast.info(duplicateCount > 0 ? `已跳过 ${duplicateCount} 个重复文件` : "没有发现支持的 Excel 文件");
      return { imported: 0, duplicates: duplicateCount };
    }
    const nextFiles = [...files, ...newPaths];
    if (nextFiles.length > MAX_INPUT_FILES) {
      appendLog(`文件数量超过上限，最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`, "error");
      toast.error(`最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`);
      return { imported: 0, duplicates: duplicateCount };
    }
    const importedTime = new Date().toLocaleString("zh-CN", { hour12: false });
    setFiles(nextFiles);
    setImportedAt((current) => ({ ...current, ...Object.fromEntries(newPaths.map((path) => [path, importedTime])) }));
    setImportModes((current) => ({ ...current, ...Object.fromEntries(newPaths.map((path) => [path, mode])) }));
    setSelectedPaths([]);
    setActiveTab("pending");
    setInputDirectorySelected(mode !== "file");
    setInputDir((current) => current || parentDirectory(newPaths[0]));
    analysesRef.current = {};
    mappingsRef.current = {};
    setAnalyses({});
    setMappings({});
    setResults({});
    setExpandedPath(null);
    setDetailPath(null);
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    setPageIndex(0);
    setActivePath("");
    confirmedPathsRef.current = new Set();
    const modeLabel = mode === "file" ? "文件" : mode === "folder" ? "文件夹" : "配置目录";
    appendLog(`已通过${modeLabel}模式加入 ${newPaths.length} 个 Excel 文件`);
    toast.success(`已导入 ${newPaths.length} 个 Excel 文件${duplicateCount ? `，跳过 ${duplicateCount} 个重复文件` : ""}`);
    return { imported: newPaths.length, duplicates: duplicateCount };
  }, [appendLog, files, setActiveTab]);

  const addFiles = useCallback((incoming: File[]): void => {
    const api = getDesktopAPI();
    if (!api) return;
    const paths = incoming.filter(isExcelFile).map((file) => {
      try {
        return api.getPathForFile(file);
      } catch {
        return "";
      }
    }).filter(Boolean);
    if (paths.length === 0) {
      appendLog("没有发现支持的 Excel 文件（xlsx、xlsm、xlsb、xls）", "warning");
      toast.warning("没有发现支持的 Excel 文件");
      return;
    }
    registerPaths(paths, "file");
  }, [appendLog, registerPaths]);

  const { getRootProps, getInputProps, isDragActive, open: openFilePicker } = useDropzone({
    accept: {
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx", ".xlsm", ".xlsb"],
    },
    maxFiles: MAX_INPUT_FILES,
    multiple: true,
    noClick: true,
    noKeyboard: true,
    onDropAccepted: addFiles,
    onDropRejected: (rejections) => {
      const message = rejections.length > MAX_INPUT_FILES ? "文件数量超过上限" : "包含不支持的文件格式";
      appendLog(message, "warning");
      toast.warning(message);
    },
  });

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const actionFiles = useMemo(
    () => (selectedPaths.length > 0 ? files.filter((path) => selectedSet.has(path)) : files),
    [files, selectedPaths.length, selectedSet],
  );

  const analyzeFiles = async (targetFiles: string[] = actionFiles): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || targetFiles.length === 0 || isAnalyzing || isRunning) return;
    setIsAnalyzing(true);
    setActiveTab("pending");
    setActivePath("");
    analysesRef.current = {};
    mappingsRef.current = {};
    setAnalyses({});
    setMappings({});
    setResults({});
    setExpandedPath(null);
    confirmedPathsRef.current = new Set();
    setProgress({ current: 0, total: targetFiles.length, phase: "analyze", path: "" });
    appendLog("开始分析 " + targetFiles.length + " 个文件");
    try {
      await api.analyzePriceFiles({ files: targetFiles, ...(configPath ? { configPath } : {}) });
    } catch (error) {
      setIsAnalyzing(false);
      appendLog("提交分析失败：" + String(error), "error");
    }
  };

  const runPricing = async (targetFiles: string[] = actionFiles): Promise<void> => {
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
      }))
      .filter((item): item is { inputPath: string; mapping: PriceCheckMapping } => item.mapping !== null);
    if (runMappings.length !== runnableFiles.length) {
      appendLog("仍有文件没有可执行字段映射，请先分析并确认", "warning");
      return;
    }
    const effectiveOutputDir = outputDir || await api.getDefaultPriceOutputDir();
    setIsAnalyzing(false);
    setIsRunning(true);
    setIsPaused(false);
    setResults({});
    setExpandedPath(null);
    setActivePath("");
    setProgress({ current: 0, total: runnableFiles.length, phase: "run", path: "" });
    appendLog("开始核价 " + runnableFiles.length + " 个文件，结果写入：" + effectiveOutputDir);
    try {
      await api.runPriceCheck({
        files: runnableFiles,
        outputDir: effectiveOutputDir,
        mappings: runMappings,
        ...(configPath ? { configPath } : {}),
      });
      if (outputDir) await api.setRuntimeConfig({ recent_output_dir: outputDir });
    } catch (error) {
      setIsRunning(false);
      appendLog("提交核价失败：" + String(error), "error");
    }
  };

  const chooseInputDirectory = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    const selected = await api.selectDirectory("input");
    if (!selected) return;
    setInputDir(selected);
    setInputDirectorySelected(true);
    try {
      const scan = await api.listExcelFiles(selected);
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
  };

  const scanConfiguredDirectory = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    try {
      const runtime = await api.getRuntimeConfig();
      const configuredDirectory = runtime.recent_input_dir?.trim();
      if (!configuredDirectory) {
        toast.error("尚未配置输入目录", {
          action: { label: "打开配置中心", onClick: () => setActivePage("config") },
        });
        return;
      }
      const scan = await api.listExcelFiles(configuredDirectory);
      setInputDir(configuredDirectory);
      setInputDirectorySelected(true);
      const summary = registerPaths(scan.files, "config");
      const skipped = scan.skippedTemporary + scan.skippedUnsupported + scan.skippedOutput;
      appendLog(
        `配置目录扫描完成：发现 ${scan.files.length} 个，导入 ${summary.imported} 个，重复 ${summary.duplicates} 个，跳过 ${skipped} 项`,
        "success",
      );
      toast.info(`扫描完成：导入 ${summary.imported}，重复 ${summary.duplicates}，跳过 ${skipped}`);
    } catch (error) {
      appendLog("扫描配置目录失败：" + String(error), "error");
      toast.error("配置输入目录不可访问", {
        action: { label: "打开配置中心", onClick: () => setActivePage("config") },
      });
    }
  };

  useEffect(() => {
    if (analysisCompletedToken === 0 || !autoRunRequestedRef.current) return;
    autoRunRequestedRef.current = false;
    const analyzedFiles = files.filter((path) => analysesRef.current[path]);
    const eligibleFiles = analyzedFiles.filter((path) => analysesRef.current[path]?.automationDecision.status === "eligible");
    const confirmCount = analyzedFiles.filter((path) => analysesRef.current[path]?.automationDecision.status === "confirm").length;
    const errorCount = analyzedFiles.filter((path) => analysesRef.current[path]?.automationDecision.status === "error").length;
    if (eligibleFiles.length === 0) {
      toast.warning(`分析完成：待确认 ${confirmCount}，异常 ${errorCount}，没有可自动核价的文件`);
      return;
    }
    toast.success(`分析完成：自动核价 ${eligibleFiles.length}，待确认 ${confirmCount}，异常 ${errorCount}`);
    void runPricing(eligibleFiles);
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
    setActivePath("");
    setFiles([]);
    setImportedAt({});
    setImportModes({});
    setSelectedPaths([]);
    setAnalyses({});
    setMappings({});
    setResults({});
    setExpandedPath(null);
    setDetailPath(null);
    analysesRef.current = {};
    mappingsRef.current = {};
    confirmedPathsRef.current = new Set();
    setInputDirectorySelected(false);
    setActiveTab("pending");
    setProgress({ current: 0, total: 0, phase: "", path: "" });
    setPageIndex(0);
    setLogs([]);
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
    if (detailPath === path) setDetailPath(null);
    if (expandedPath === path) setExpandedPath(null);
  };

  const toggleSelected = (path: string): void => {
    setSelectedPaths((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  };

  const toggleAllSelected = (): void => {
    const visiblePaths = files.filter((path) => {
      const status = statusForFile(path, analyses[path], results[path], activePath, isAnalyzing || isRunning);
      return tabForStatus(status) === activeTab;
    });
    const allSelected = visiblePaths.length > 0 && visiblePaths.every((path) => selectedSet.has(path));
    setSelectedPaths((current) => (allSelected ? current.filter((path) => !visiblePaths.includes(path)) : Array.from(new Set([...current, ...visiblePaths]))));
  };

  const updateMapping = (path: string, orderSheet: string, pricingSheet: string): void => {
    const analysis = analyses[path];
    if (!analysis) return;
    const order = analysis.orderSheetCandidates.find((item) => item.sheetName === orderSheet);
    const pricing = analysis.pricingSheetCandidates.find((item) => item.sheetName === pricingSheet);
    if (order && pricing) {
      const nextMapping = buildMapping(order, pricing);
      mappingsRef.current = { ...mappingsRef.current, [path]: nextMapping };
      setMappings((current) => ({ ...current, [path]: nextMapping }));
    }
  };

  const confirmAndContinue = async (path: string): Promise<void> => {
    const mapping = mappingsRef.current[path] ?? mappings[path];
    if (!mappingIsComplete(mapping)) {
      toast.error("字段映射不完整，或订单 Sheet 与核价 Sheet 相同");
      return;
    }
    confirmedPathsRef.current.add(path);
    setDetailPath(null);
    toast.success("映射已确认，开始处理当前文件");
    await runPricing([path]);
  };

  const retryAnalysis = async (path: string): Promise<void> => {
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
    confirmedPathsRef.current.delete(path);
    setActiveTab("pending");
    autoRunRequestedRef.current = true;
    await analyzeFiles([path]);
  };

  const fileStatusByPath = useMemo<Record<string, FileStatus>>(
    () =>
      Object.fromEntries(
        files.map((path) => [path, statusForFile(path, analyses[path], results[path], activePath, isAnalyzing || isRunning)]),
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
      const selectColumn: ColumnDef<string> = { id: "select", header: "", enableSorting: false, enableHiding: false };
      const indexColumn: ColumnDef<string> = { id: "index", header: "序号", enableSorting: false, enableHiding: false };
      const fileColumn: ColumnDef<string> = { id: "fileName", header: "原始文件名", accessorFn: fileNameFromPath };
      const actionColumn: ColumnDef<string> = { id: "actions", header: "操作", enableSorting: false, enableHiding: false };
      const orderColumn: ColumnDef<string> = { id: "orderSheet", header: "订单 Sheet", accessorFn: (path) => (mappings[path] ?? analyses[path]?.suggestedMapping)?.orderSheet ?? "" };
      const pricingColumn: ColumnDef<string> = { id: "pricingSheet", header: "核价 Sheet", accessorFn: (path) => (mappings[path] ?? analyses[path]?.suggestedMapping)?.pricingSheet ?? "" };
      const coverageColumn: ColumnDef<string> = { id: "coverage", header: "匹配率", accessorFn: (path) => results[path]?.coverage ?? analyses[path]?.coverage ?? -1 };
      if (activeTab === "pending") return [selectColumn, indexColumn, fileColumn,
        { id: "importMode", header: "导入方式", accessorFn: (path) => importModes[path] ?? "file" },
        { id: "status", header: "处理阶段", accessorFn: (path) => fileStatusByPath[path] },
        { id: "createdAt", header: "导入时间", accessorFn: (path) => importedAt[path] ?? "" }, actionColumn];
      if (activeTab === "confirm") return [selectColumn, indexColumn, fileColumn, orderColumn, pricingColumn, coverageColumn,
        { id: "evidence", header: "试算行数", accessorFn: (path) => analyses[path]?.automationDecision.evaluatedRows ?? 0 },
        { id: "issue", header: "待确认原因", accessorFn: (path) => analyses[path]?.automationDecision.reasons.join("；") ?? "" }, actionColumn];
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
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
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
  const phaseLabel = progress.phase === "analyze" ? "分析" : progress.phase === "rows" ? "写入" : progress.phase === "run" ? "核价" : "等待操作";
  const detailAnalysis = detailPath ? analyses[detailPath] : undefined;
  const detailResult = detailPath ? results[detailPath] : undefined;
  const detailMapping = detailPath ? mappings[detailPath] ?? detailAnalysis?.suggestedMapping ?? null : null;

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

  const renderTaskActions = (className: string, showReset = false): React.JSX.Element => (
    <div className={className} aria-label="快捷操作">
      <SidebarTooltip label="扫描配置中的输入目录" enabled={sidebarCollapsed}><button type="button" aria-label="扫描配置中的输入目录" className="cyber-action is-scan" onClick={() => void scanConfiguredDirectory()} data-unavailable={isAnalyzing || isRunning}><ScanSearch /><strong>扫描目录</strong></button></SidebarTooltip>
      <SidebarTooltip label="开始处理" enabled={sidebarCollapsed}><button type="button" aria-label="开始处理" className="cyber-action is-start" onClick={() => void startCurrentTask()} data-unavailable={isAnalyzing || isRunning}><Play /><strong>开始处理</strong></button></SidebarTooltip>
      <SidebarTooltip label={isPaused ? "继续任务" : "暂停任务"} enabled={sidebarCollapsed}><button type="button" aria-label={isPaused ? "继续任务" : "暂停任务"} className="cyber-action is-pause" onClick={() => void togglePauseTask()} data-unavailable={!isAnalyzing && !isRunning}>{isPaused ? <Play /> : <Pause />}<strong>{isPaused ? "继续任务" : "暂停任务"}</strong></button></SidebarTooltip>
      <SidebarTooltip label="停止任务" enabled={sidebarCollapsed}><button type="button" aria-label="停止任务" className="cyber-action is-stop" onClick={() => void stopCurrentTask()} data-unavailable={!isAnalyzing && !isRunning}><CircleStop /><strong>停止任务</strong></button></SidebarTooltip>
      {showReset ? <button type="button" aria-label="重置任务" className="cyber-action is-reset" onClick={() => void resetTask()}><RefreshCw /><strong>重置</strong></button> : null}
    </div>
  );

  const showComingSoon = (label: string): void => {
    toast.info(label + "正在建设中");
  };

  const activeNavigationItem = navigationItems.find((item) => item.key === activePage) ?? navigationItems[0];
  const ActiveNavigationIcon = activeNavigationItem.icon;

  return (
    <TooltipProvider delayDuration={220} skipDelayDuration={80}>
    <MotionConfig reducedMotion="user">
      <main className={"cyber-app" + (sidebarCollapsed ? " is-sidebar-collapsed" : "")} ref={shellRef}>
        <Toaster richColors position="top-right" closeButton theme={theme} />

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
              const isLogEntry = key === "logs";
              const isActive = isLogEntry ? isLogDrawerOpen : activePage === key;
              const navigationButton = (
                <button
                  type="button"
                  className={isActive ? "is-active" : undefined}
                  aria-current={!isLogEntry && isActive ? "page" : undefined}
                  aria-controls={isLogEntry ? "log-drawer" : undefined}
                  aria-expanded={isLogEntry ? isLogDrawerOpen : undefined}
                  onClick={() => isLogEntry ? setIsLogDrawerOpen(true) : setActivePage(key)}
                >
                  <Icon /><span>{label}</span>
                </button>
              );
              return <SidebarTooltip label={label} enabled={sidebarCollapsed} key={key}>{navigationButton}</SidebarTooltip>;
            })}
          </nav>

          {sidebarCollapsed ? renderTaskActions("cyber-rail-actions") : null}

          <div className="cyber-sidebar-tools">
            <SidebarTooltip label="配置中心" enabled={sidebarCollapsed}><button type="button" aria-label="配置中心" onClick={() => setActivePage("config")}><Settings /></button></SidebarTooltip>
            <SidebarTooltip label="帮助" enabled={sidebarCollapsed}><button type="button" aria-label="帮助" onClick={() => showComingSoon("帮助中心")}><CircleHelp /></button></SidebarTooltip>
            <SidebarTooltip label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} enabled={sidebarCollapsed}><button type="button" aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={toggleTheme}>{theme === "dark" ? <Moon /> : <Sun />}</button></SidebarTooltip>
            <SidebarTooltip label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} enabled={sidebarCollapsed}><button type="button" aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></SidebarTooltip>
          </div>
        </aside>

        <AnimatePresence>
          {isLogDrawerOpen ? <>
            <motion.button
              type="button"
              className="cyber-drawer-backdrop"
              aria-label="关闭运行日志"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsLogDrawerOpen(false)}
            />
            <motion.aside
              id="log-drawer"
              className="cyber-log-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby="log-drawer-title"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <header>
                <div><span className="panel-icon"><FileClock /></span><div><strong id="log-drawer-title">运行日志</strong><small>{logs.length} 条记录</small></div></div>
                <div className="cyber-log-drawer-actions">
                  <button type="button" onClick={() => setLogs([])} disabled={logs.length === 0}><Trash2 />清空</button>
                  <button type="button" ref={logDrawerCloseRef} aria-label="关闭日志抽屉" onClick={() => setIsLogDrawerOpen(false)}><X /></button>
                </div>
              </header>
              <div className="cyber-log-summary" aria-label="任务状态">
                {fileTabs.map((tab) => <span key={tab.key}><i className={"is-" + tab.key} />{tab.label}<b>{tabCounts[tab.key]}</b></span>)}
              </div>
              <div className="cyber-log-list" role="log" aria-live="polite">
                {logs.length === 0 ? <div className="cyber-log-empty"><FileClock /><strong>暂无运行日志</strong><span>导入或处理文件后，日志会显示在这里</span></div> : null}
                {logs.map((log) => (
                  <div className={"cyber-log-row is-" + log.level} key={log.id} title={log.message}>
                    <i /><time>{log.time}</time><em>{log.level === "success" ? "成功" : log.level === "error" ? "异常" : log.level === "warning" ? "提示" : "信息"}</em><span>{log.message}</span>
                  </div>
                ))}
              </div>
            </motion.aside>
          </> : null}
        </AnimatePresence>

        <AnimatePresence>
          {detailPath ? <>
            <motion.button type="button" className="cyber-drawer-backdrop" aria-label="关闭问题详情" onClick={() => setDetailPath(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.aside className="cyber-issue-drawer" role="dialog" aria-modal="true" aria-label="文件处理详情" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.2 }}>
              <header><div><FileSpreadsheet /><div><strong>{fileNameFromPath(detailPath)}</strong><small title={detailPath}>{detailPath}</small></div></div><div className="issue-header-actions"><Button type="button" variant="outline" className="issue-open-source" onClick={() => void getDesktopAPI()?.openPath(detailPath)}><ExternalLink />打开原始文件</Button><button type="button" aria-label="关闭文件详情" onClick={() => setDetailPath(null)}><X /></button></div></header>
              <div className="issue-timeline" aria-label="处理时间线">
                {["导入", "分析", "确认", "核价", "完成"].map((label, index) => {
                  const reached = index === 0 || index === 1 && Boolean(detailAnalysis) || index === 2 && detailAnalysis?.automationDecision.status === "confirm" || index === 3 && Boolean(detailResult) || index === 4 && detailResult?.status === "completed" && (detailResult.exceptionRows ?? 0) === 0;
                  return <span className={reached ? "is-reached" : ""} key={label}><i />{label}</span>;
                })}
              </div>
              <div className="issue-drawer-content">
                <section><h3>自动化判定</h3>{detailAnalysis ? <><div className={"decision-card is-" + detailAnalysis.automationDecision.status}><strong>{detailAnalysis.automationDecision.status === "eligible" ? "可自动处理" : detailAnalysis.automationDecision.status === "confirm" ? "需要人工确认" : "分析异常"}</strong><span>试算 {detailAnalysis.automationDecision.matchedRows}/{detailAnalysis.automationDecision.evaluatedRows} 行 · {formatCoverage(detailAnalysis.automationDecision.coverage)}</span></div><ul>{detailAnalysis.automationDecision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></> : <p>文件尚未分析。</p>}</section>
                {detailAnalysis ? <section><h3>候选映射</h3><div className="candidate-grid"><div><strong>订单 Sheet</strong>{detailAnalysis.orderSheetCandidates.slice(0, 3).map((candidate) => <span key={candidate.sheetName}>{candidate.sheetName}<em>{candidate.score.toFixed(1)}</em></span>)}</div><div><strong>核价 Sheet</strong>{detailAnalysis.pricingSheetCandidates.slice(0, 3).map((candidate) => <span key={candidate.sheetName}>{candidate.sheetName}<em>{candidate.score.toFixed(1)}</em></span>)}</div></div>{detailAnalysis.automationDecision.status === "confirm" ? <div className="drawer-mapping-actions"><label>订单 Sheet<select value={detailMapping?.orderSheet ?? ""} onChange={(event) => updateMapping(detailPath, event.currentTarget.value, detailMapping?.pricingSheet ?? "")}>{detailAnalysis.orderSheetCandidates.map((candidate) => <option key={candidate.sheetName}>{candidate.sheetName}</option>)}</select></label><label>核价 Sheet<select value={detailMapping?.pricingSheet ?? ""} onChange={(event) => updateMapping(detailPath, detailMapping?.orderSheet ?? "", event.currentTarget.value)}>{detailAnalysis.pricingSheetCandidates.map((candidate) => <option key={candidate.sheetName}>{candidate.sheetName}</option>)}</select></label><Button onClick={() => void confirmAndContinue(detailPath)}>确认并继续</Button></div> : null}</section> : null}
                {detailResult ? <section><h3>处理结果</h3><div className="result-summary"><span>总行数<strong>{detailResult.totalRows ?? 0}</strong></span><span>已匹配<strong>{detailResult.matchedRows ?? 0}</strong></span><span>异常行<strong>{detailResult.exceptionRows ?? 0}</strong></span></div>{detailResult.message ? <p>{detailResult.message}</p> : null}{detailResult.outputPath ? <Button variant="outline" onClick={() => void getDesktopAPI()?.openPath(detailResult.outputPath ?? "")}>打开结果文件</Button> : null}</section> : null}
              </div>
            </motion.aside>
          </> : null}
        </AnimatePresence>

        <section className={`cyber-workspace is-${activePage}` + (!["workbench", "files", "config"].includes(activePage) ? " is-coming-soon" : "")}>
          {activePage === "workbench" ? (
            <DashboardPage
              api={getDesktopAPI()}
              dark={theme === "dark"}
              currentFileCount={files.length}
              outputDir={outputDir}
              onNewProcessing={() => { setActivePage("files"); openFilePicker(); }}
              onOpenFiles={() => setActivePage("files")}
              onOpenConfig={() => setActivePage("config")}
            />
          ) : activePage === "files" ? <>
          <section className="cyber-upload-panel" aria-labelledby="upload-title">
            <header>
              <div><span className="panel-icon"><FileBox /></span><h2 id="upload-title">文件处理</h2></div>
              {!sidebarCollapsed ? renderTaskActions("cyber-workbench-actions", true) : null}
              <div className="panel-note">原始 Excel 不会被覆盖 <Badge variant="outline">{files.length} 个文件</Badge></div>
            </header>
            <div className="cyber-pipeline" aria-label="自动处理流程">
              <span className={files.length ? "is-done" : ""}><b>1</b>导入<em>{files.length}</em></span>
              <span className={Object.keys(analyses).length ? "is-done" : isAnalyzing ? "is-active" : ""}><b>2</b>分析<em>{Object.keys(analyses).length}</em></span>
              <span className={tabCounts.confirm ? "is-warning" : ""}><b>3</b>确认<em>{tabCounts.confirm}</em></span>
              <span className={isRunning ? "is-active" : Object.keys(results).length ? "is-done" : ""}><b>4</b>核价<em>{Object.keys(results).length}</em></span>
              <span className={tabCounts.success ? "is-done" : ""}><b>5</b>完成<em>{tabCounts.success}</em></span>
            </div>
            <div {...getRootProps({ className: "cyber-dropzone" + (isDragActive ? " is-dragging" : "") })}>
              <input {...getInputProps()} />
              <div className="cyber-wave" aria-hidden="true" />
              <div className="cyber-upload-visual" aria-hidden="true"><FileUp /></div>
              <strong>拖拽 Excel 文件到此处</strong>
              <span>或点击选择本地文件</span>
              <small>支持格式：.xlsx、.xls、.xlsm、.xlsb</small>
              <div className="cyber-import-choices">
                <Button type="button" className="cyber-select-file" onClick={(event) => { event.stopPropagation(); openFilePicker(); }}><FileUp />选择文件</Button>
                <Button type="button" variant="outline" className="cyber-select-folder" onClick={(event) => { event.stopPropagation(); void chooseInputDirectory(); }}><FolderOpen />选择文件夹</Button>
              </div>
            </div>
          </section>

          <section className="cyber-table-panel">
            <header className="cyber-table-toolbar">
              <h2>文件列表 <span>（{visibleFiles.length}）</span></h2>
              <div className="cyber-table-actions">
                <div className="cyber-tabs" aria-label="文件状态统计">
                  {fileTabs.map((tab) => <button type="button" className={activeTab === tab.key ? "is-active" : ""} key={tab.key} onClick={() => setActiveTab(tab.key)}>{tab.label}<b>{tabCounts[tab.key]}</b></button>)}
                </div>
                <details className="cyber-column-manager">
                  <summary aria-label="列管理"><Settings2 /></summary>
                  <div>{fileTable.getAllLeafColumns().filter((column) => column.getCanHide()).map((column) => <label key={column.id}><Checkbox checked={column.getIsVisible()} onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))} />{String(column.columnDef.header)}</label>)}</div>
                </details>
              </div>
            </header>

            <div className="cyber-table-scroll" ref={tableScrollRef}>
              <table className={`cyber-file-table is-${activeTab}`}>
                <thead><tr>{fileTable.getVisibleLeafColumns().map((column) => <th key={column.id} className={column.id === "select" ? "checkbox-column" : column.id === "index" ? "index-column" : column.id === "actions" ? "action-column" : undefined}>{column.id === "select" ? <Checkbox checked={selectedAll} onCheckedChange={() => toggleAllSelected()} aria-label="全选当前状态文件" /> : <button type="button" disabled={!column.getCanSort()} onClick={column.getToggleSortingHandler()}>{String(column.columnDef.header)}{column.getCanSort() ? <ArrowUpDown /> : null}</button>}</th>)}</tr></thead>
                <tbody style={shouldVirtualizeRows ? { height: rowVirtualizer.getTotalSize(), position: "relative" } : undefined}>
                  {renderedTableRows.length === 0 ? <tr><td colSpan={fileTable.getVisibleLeafColumns().length}><div className="cyber-empty"><div className="cyber-empty-visual" aria-hidden="true"><Inbox /></div><strong>暂无文件</strong><span>导入后将在这里显示</span></div></td></tr> : null}
                  {renderedTableRows.map(({ row, virtualRow }) => {
                    const path = row.original;
                    const analysis = analyses[path];
                    const result = results[path];
                    const currentMapping = mappings[path] ?? analysis?.suggestedMapping ?? null;
                    const status = fileStatusByPath[path];
                    const isExpanded = expandedPath === path;
                    return <Fragment key={path}>
                      <tr ref={virtualRow ? rowVirtualizer.measureElement : undefined} data-index={virtualRow?.index} className={selectedSet.has(path) ? "is-selected" : ""} style={virtualRow ? { position: "absolute", transform: `translateY(${virtualRow.start}px)`, width: "100%", display: "table", tableLayout: "fixed" } : undefined}>
                        {row.getVisibleCells().map((cell) => {
                          if (cell.column.id === "select") return <td key={cell.id} className="checkbox-column"><Checkbox checked={selectedSet.has(path)} onCheckedChange={() => toggleSelected(path)} aria-label={"选择 " + fileNameFromPath(path)} /></td>;
                          if (cell.column.id === "index") return <td key={cell.id} className="index-column">{files.indexOf(path) + 1}</td>;
                           if (cell.column.id === "fileName") return <td key={cell.id} className="file-cell"><FileSpreadsheet /><button type="button" onClick={() => void openSourceDirectory(path)} title={path}>{fileNameFromPath(path)}</button></td>;
                           if (cell.column.id === "orderSheet") return <td key={cell.id}>{currentMapping?.orderSheet ?? "—"}</td>;
                           if (cell.column.id === "pricingSheet") return <td key={cell.id}>{currentMapping?.pricingSheet ?? "—"}</td>;
                           if (cell.column.id === "coverage") { const value = result?.coverage ?? analysis?.coverage; return <td key={cell.id}>{value === undefined ? "—" : <div className="coverage-cell"><Progress value={value * 100} /><span>{formatCoverage(value)}</span></div>}</td>; }
                           if (cell.column.id === "importMode") return <td key={cell.id}>{importModes[path] === "folder" ? "文件夹" : importModes[path] === "config" ? "配置目录" : "文件"}</td>;
                           if (cell.column.id === "status") return <td key={cell.id}><span className={"cyber-status is-" + statusMeta[status].tone}><i />{statusMeta[status].label}</span>{result?.status === "completed" ? <small>{result.matchedRows ?? 0}/{result.totalRows ?? 0} 行</small> : null}</td>;
                           if (cell.column.id === "createdAt") return <td key={cell.id}>{importedAt[path] ?? "—"}</td>;
                           if (cell.column.id === "evidence") return <td key={cell.id}>{analysis?.automationDecision.evaluatedRows ?? 0} 行</td>;
                           if (cell.column.id === "issue") { const issue = result?.status === "completed" && (result.exceptionRows ?? 0) > 0 ? `${result.exceptionRows} 行存在异常` : result?.message ?? analysis?.automationDecision.reasons[0] ?? analysis?.issues[0] ?? "—"; return <td key={cell.id} className="issue-cell" title={issue}>{issue}</td>; }
                           if (cell.column.id === "rows") return <td key={cell.id}>{result ? `${result.matchedRows ?? 0}/${result.totalRows ?? 0}` : "—"}</td>;
                           if (cell.column.id === "completedAt") return <td key={cell.id}>{result?.completedAt ?? importedAt[path] ?? "—"}</td>;
                           return <td key={cell.id} className="action-column"><button type="button" onClick={() => setDetailPath(path)}>详情</button>{activeTab === "confirm" ? <><button type="button" onClick={() => setExpandedPath(isExpanded ? null : path)}>{isExpanded ? <ChevronDown /> : <ChevronRight />}字段</button><button type="button" onClick={() => void confirmAndContinue(path)}>确认</button></> : null}{activeTab === "error" ? <button type="button" onClick={() => void retryAnalysis(path)}>重试</button> : null}{result?.outputPath ? <button type="button" onClick={() => void getDesktopAPI()?.openPath(result.outputPath ?? "")}>打开</button> : null}{activeTab === "pending" ? <button type="button" disabled={isAnalyzing || isRunning} onClick={() => removeFile(path)} aria-label={"移除 " + fileNameFromPath(path)}><X /></button> : null}</td>;
                        })}
                      </tr>
                      {isExpanded ? <tr className="cyber-detail"><td colSpan={fileTable.getVisibleLeafColumns().length}>{analysis ? <div><label>订单 Sheet<select value={currentMapping?.orderSheet ?? ""} onChange={(event) => updateMapping(path, event.currentTarget.value, currentMapping?.pricingSheet ?? "")}>{analysis.orderSheetCandidates.map((candidate) => <option value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName}</option>)}</select></label><label>核价 Sheet<select value={currentMapping?.pricingSheet ?? ""} onChange={(event) => updateMapping(path, currentMapping?.orderSheet ?? "", event.currentTarget.value)}>{analysis.pricingSheetCandidates.map((candidate) => <option value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName}</option>)}</select></label></div> : <span>尚未分析此文件</span>}</td></tr> : null}
                    </Fragment>;
                  })}
                </tbody>
              </table>
            </div>

            <footer className="cyber-pagination">
              <button type="button" aria-label="上一页" disabled={pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}><ChevronLeft /></button>
              <strong>{pageIndex + 1}</strong>
              <button type="button" aria-label="下一页" disabled={pageIndex + 1 >= pageCount} onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}><ChevronRight /></button>
              <select aria-label="每页条数" value={pageSize} onChange={(event) => setPageSize(Number(event.currentTarget.value))}><option value={50}>50 条/页</option><option value={100}>100 条/页</option><option value={200}>200 条/页</option></select>
            </footer>
          </section>
          </> : activePage === "config" ? (
            <ConfigCenterPage api={getDesktopAPI()} />
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

        <footer className="cyber-footer">{fileTabs.map((tab) => <span key={tab.key}><i className={"is-" + tab.key} />{tab.label} {tabCounts[tab.key]}</span>)}</footer>
      </main>
    </MotionConfig>
    </TooltipProvider>
  );

  return (
    <MotionConfig reducedMotion="user">
    <main className="app-shell" ref={shellRef}>
      <Toaster richColors position="top-right" closeButton theme={theme} />
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
            <IconAction icon={RefreshCw} label="重置" onClick={() => void resetTask()} />
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
                          return <td key={cell.id} className="action-column"><button type="button" className="row-action" onClick={() => setExpandedPath(isExpanded ? null : path)}>{isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}字段</button>{result?.outputPath ? <button type="button" className="row-link" onClick={() => void getDesktopAPI()?.openPath(result.outputPath ?? "")}>打开</button> : null}<button type="button" className="row-remove" disabled={isAnalyzing || isRunning} onClick={() => removeFile(path)} aria-label={"移除 " + fileNameFromPath(path)}><X size={15} /></button></td>;
                        })}
                      </tr>
                      {isExpanded ? (
                        <tr className="detail-row" key={path + "-detail"}><td colSpan={fileTable.getVisibleLeafColumns().length}><div className="detail-panel">
                          {analysis ? (
                            <>
                              <div className="detail-grid">
                                <label>订单 Sheet<select value={currentMapping?.orderSheet ?? ""} onChange={(event) => updateMapping(path, event.currentTarget.value, currentMapping?.pricingSheet ?? "")}>{analysis.orderSheetCandidates.map((candidate) => <option value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.validOrderRows ?? 0} 行</option>)}</select></label>
                                <label>核价 Sheet<select value={currentMapping?.pricingSheet ?? ""} onChange={(event) => updateMapping(path, currentMapping?.orderSheet ?? "", event.currentTarget.value)}>{analysis.pricingSheetCandidates.map((candidate) => <option value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.validPriceRows ?? 0} 行</option>)}</select></label>
                              </div>
                              {currentMapping ? <div className="mapping-line"><span>表头：订单第 {currentMapping.orderHeaderRow} 行 / 核价第 {currentMapping.pricingHeaderRow} 行</span><span>订单号：{columnLabel(currentMapping.businessOrderNumberColumn ?? currentMapping.platformOrderNumberColumn)}</span><span>国家：{columnLabel(currentMapping.countryCodeColumn)} + {columnLabel(currentMapping.countryEnglishColumn)} + {columnLabel(currentMapping.countryChineseColumn)}</span><span>SKU/数量：{currentMapping.skuQtyPairs.map((pair) => pair.skuColumn + "/" + pair.qtyColumn).join("、") || "未识别"}</span><span>数量档位：{currentMapping.quantityTierColumns.map((tier) => tier.quantity).join("、") || "未识别"}</span></div> : null}
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
