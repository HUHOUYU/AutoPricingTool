import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus2,
  FileSpreadsheet,
  FolderOpen,
  FolderOutput,
  Play,
  RefreshCw,
  ScanSearch,
  Settings2,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
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
};

type LogEntry = {
  id: number;
  time: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
};

type FileStatus = "pending" | "running" | "ready" | "success" | "warning" | "error";
type FileTab = "pending" | "confirm" | "error" | "success";

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
  if (status === "pending") return "pending";
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
  if (analysis) return isAnalysisError(analysis) ? "error" : "ready";
  return "pending";
}

type IconActionProps = {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: "normal" | "primary" | "danger";
};

function IconAction({ icon: Icon, label, onClick, disabled = false, active = false, tone = "normal" }: IconActionProps): JSX.Element {
  return (
    <button
      type="button"
      className={["icon-action", active ? "is-active" : "", tone !== "normal" ? "is-" + tone : ""].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

export function App(): JSX.Element {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, PriceAnalysisFile>>({});
  const [mappings, setMappings] = useState<Record<string, PriceCheckMapping>>({});
  const [results, setResults] = useState<Record<string, FileResult>>({});
  const [inputDir, setInputDir] = useState("");
  const [inputDirectorySelected, setInputDirectorySelected] = useState(false);
  const [outputDir, setOutputDir] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [activeTab, setActiveTab] = useState<FileTab>("pending");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: "", path: "" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const analysesRef = useRef<Record<string, PriceAnalysisFile>>({});
  const mappingsRef = useRef<Record<string, PriceCheckMapping>>({});
  const confirmedPathsRef = useRef<Set<string>>(new Set());

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
        } else {
          setIsRunning(false);
          setIsPaused(false);
          appendLog(event.stopped ? "核价已停止" : "核价完成", event.stopped ? "warning" : "success");
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

  const addFiles = useCallback(
    (incoming: File[]): void => {
      const api = getDesktopAPI();
      if (!api) return;
      const paths = incoming
        .filter(isExcelFile)
        .map((file) => {
          try {
            return api.getPathForFile(file);
          } catch {
            return "";
          }
        })
        .filter(Boolean);
      if (paths.length === 0) {
        appendLog("没有发现支持的 Excel 文件（xlsx、xlsm、xlsb、xls）", "warning");
        return;
      }
      const nextFiles = Array.from(new Set([...files, ...paths]));
      if (nextFiles.length > MAX_INPUT_FILES) {
        appendLog(`文件数量超过上限，最多支持 ${MAX_INPUT_FILES} 个 Excel 文件`, "error");
        return;
      }
      setFiles(nextFiles);
      setSelectedPaths([]);
      setActiveTab("pending");
      setInputDirectorySelected(false);
      setInputDir((current) => current || parentDirectory(paths[0]));
      analysesRef.current = {};
      mappingsRef.current = {};
      setAnalyses({});
      setMappings({});
      setResults({});
      setExpandedPath(null);
      setProgress({ current: 0, total: 0, phase: "", path: "" });
      setActivePath("");
      confirmedPathsRef.current = new Set();
      if (!outputDir) setOutputDir(parentDirectory(paths[0]));
      appendLog("已加入 " + paths.length + " 个 Excel 文件");
    },
    [appendLog, files, outputDir],
  );

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

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
    const effectiveOutputDir = outputDir || parentDirectory(runnableFiles[0]);
    setIsAnalyzing(false);
    setOutputDir(effectiveOutputDir);
    setIsRunning(true);
    setIsPaused(false);
    setResults({});
    setExpandedPath(null);
    setActivePath("");
    setProgress({ current: 0, total: runnableFiles.length, phase: "run", path: "" });
    appendLog("开始核价 " + runnableFiles.length + " 个文件，结果写入：" + effectiveOutputDir + "\\核价结果");
    try {
      await api.runPriceCheck({
        files: runnableFiles,
        outputDir: effectiveOutputDir,
        mappings: runMappings,
        ...(configPath ? { configPath } : {}),
      });
      await api.setRuntimeConfig({ recent_output_dir: effectiveOutputDir });
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
    if (!outputDir) setOutputDir(selected);
    appendLog("目标文件夹已选择：" + selected + "，点击“扫描”开始分析", "success");
  };

  const scanFiles = async (): Promise<void> => {
    const api = getDesktopAPI();
    if (!api || isAnalyzing || isRunning) return;
    let targetFiles = actionFiles;
    if (inputDirectorySelected && inputDir) {
      try {
        const discovered = await api.listExcelFiles(inputDir);
        if (discovered.length > MAX_INPUT_FILES) {
          appendLog(`文件夹超过 ${MAX_INPUT_FILES} 个文件上限，未开始分析`, "error");
          return;
        }
        setFiles(discovered);
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
    setSelectedPaths([]);
    setAnalyses({});
    setMappings({});
    setResults({});
    setExpandedPath(null);
    analysesRef.current = {};
    mappingsRef.current = {};
    confirmedPathsRef.current = new Set();
    setInputDirectorySelected(false);
    setActiveTab("pending");
    setProgress({ current: 0, total: 0, phase: "", path: "" });
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
      confirmedPathsRef.current.add(path);
    }
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

  const completedDotCount = progressDotCounts.success + progressDotCounts.warning + progressDotCounts.error;
  const progressPercent = progress.total > 0
    ? Math.round(Math.min(1, progress.current / progress.total) * 100)
    : files.length > 0
      ? Math.round((completedDotCount / files.length) * 100)
      : 0;
  const totalMatched = useMemo(() => Object.values(results).reduce((sum, item) => sum + (item.matchedRows ?? 0), 0), [results]);
  const totalRows = useMemo(() => Object.values(results).reduce((sum, item) => sum + (item.totalRows ?? 0), 0), [results]);
  const selectedAll = visibleFiles.length > 0 && visibleFiles.every((path) => selectedSet.has(path));
  const phaseLabel = progress.phase === "analyze" ? "分析" : progress.phase === "rows" ? "写入" : progress.phase === "run" ? "核价" : "等待操作";

  return (
    <main className="app-shell">
      <aside className="left-rail">
        <div className="rail-brand">
          <div className="brand-mark"><FileSpreadsheet size={21} strokeWidth={1.8} /></div>
          <div>
            <strong>自动核价工作台</strong>
            <span>AutoPricingTool</span>
          </div>
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

        <section className="log-panel" aria-label="运行日志">
          <div className="log-header">
            <div>
              <h1>运行日志</h1>
              <span>{logs.length} 条记录</span>
            </div>
            <div className="log-header-actions">
              <span className={isAnalyzing || isRunning ? "run-pill is-running" : "run-pill"}>{isPaused ? "处理中" : isAnalyzing ? "分析中" : isRunning ? "核价中" : "待处理"}</span>
              <IconAction icon={Download} label="导出日志" onClick={() => void exportLogs()} />
              <IconAction icon={Trash2} label="清空日志" onClick={() => setLogs([])} />
            </div>
          </div>
          <div className="pinned-paths">
            <div className="pinned-path"><span>目标</span><code title={inputDir}>{inputDir || "未选择输入文件夹"}</code></div>
            <div className="pinned-path"><span>输出</span><code title={outputDir}>{outputDir || "未选择输出文件夹"}</code></div>
            <div className="pinned-path"><span>配置</span><code title={configPath}>{configPath || "内置配置"}</code></div>
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
              <span>文件进度</span>
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
        <header className="workspace-toolbar">
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
        </header>

        <div className="workspace-heading">
          <div>
            <p className="workspace-kicker">EXCEL PRICING DESK</p>
            <h2>订单批量核价</h2>
            <span>拖入 Excel 或选择目标文件夹，自动识别订单 Sheet、核价 Sheet 和数量档位。</span>
          </div>
          <div className="workspace-progress-summary">
            <strong>{progressPercent}%</strong>
            <span>{phaseLabel} · {progress.total > 0 ? progress.current + "/" + progress.total : completedDotCount + "/" + files.length}</span>
          </div>
        </div>

        <section
          className={"drop-zone import-strip" + (dragActive ? " is-dragging" : "")}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragActive(false);
          }}
          onDrop={handleDrop}
        >
          <div className="import-icon"><FilePlus2 size={19} strokeWidth={1.8} /></div>
          <div className="import-copy">
            <strong>把 Excel 文件拖到这里</strong>
            <span>支持 xlsx、xlsm、xlsb、xls · 选择目标文件夹后点击左侧“扫描”</span>
          </div>
        </section>

        <div className="table-panel">
          <div className="table-toolbar">
            <div className="table-title"><strong>{files.length} 个文件，当前显示 {visibleFiles.length} 个，已选 {selectedPaths.length} 个</strong><span>{activePath ? "正在处理：" + fileNameFromPath(activePath) : "原始 Excel 不会被覆盖"}</span></div>
          </div>
          <div className="table-scroll">
            <table className="file-table">
              <thead>
                <tr>
                  <th className="checkbox-column"><input type="checkbox" checked={selectedAll} onChange={toggleAllSelected} aria-label="全选当前 Tab 文件" /></th>
                  <th className="index-column">序号</th>
                  <th>原始文件名</th>
                  <th>订单 Sheet</th>
                  <th>核价 Sheet</th>
                  <th>覆盖率</th>
                  <th>状态</th>
                  <th className="action-column">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleFiles.length === 0 ? (
                  <tr><td colSpan={8}><div className="table-empty"><FileSpreadsheet size={30} strokeWidth={1.5} /><strong>{files.length === 0 ? "暂无 Excel 文件" : fileTabs.find((tab) => tab.key === activeTab)?.label + "暂无文件"}</strong><span>{files.length === 0 ? "把 Excel 文件拖入上方区域，或选择目标文件夹后点击扫描" : "切换其他 Tab 查看当前任务"}</span></div></td></tr>
                ) : null}
                {visibleFiles.map((path) => {
                  const index = files.indexOf(path);
                  const analysis = analyses[path];
                  const result = results[path];
                  const currentMapping = mappings[path] ?? analysis?.suggestedMapping ?? null;
                  const status = fileStatusByPath[path];
                  const isExpanded = expandedPath === path;
                  return (
                    <Fragment key={path}>
                      <tr className={"file-row is-" + status + (selectedSet.has(path) ? " is-selected" : "")}>
                        <td className="checkbox-column"><input type="checkbox" checked={selectedSet.has(path)} onChange={() => toggleSelected(path)} aria-label={"选择 " + fileNameFromPath(path)} /></td>
                        <td className="index-column">{index + 1}</td>
                        <td className="file-name-cell">
                          <FileSpreadsheet size={17} strokeWidth={1.7} />
                          <button type="button" className="file-name-button" onClick={() => void openSourceDirectory(path)} title={path}>
                            <strong>{fileNameFromPath(path)}</strong>
                            <span>{path}</span>
                          </button>
                        </td>
                        <td>{currentMapping?.orderSheet ?? "—"}</td>
                        <td>{currentMapping?.pricingSheet ?? "—"}</td>
                        <td><span className={analysis && analysis.coverage >= 0.95 ? "coverage-label is-good" : analysis ? "coverage-label is-warning" : "coverage-label"}>{analysis ? "覆盖率 " + formatCoverage(analysis.coverage) : "—"}</span></td>
                        <td><span className={"table-status is-" + statusMeta[status].tone}><span className="status-dot" />{statusMeta[status].label}</span>{result?.status === "completed" ? <small className="status-count">{result.matchedRows ?? 0}/{result.totalRows ?? 0} 行已核价</small> : null}</td>
                        <td className="action-column"><button type="button" className="row-action" onClick={() => setExpandedPath(isExpanded ? null : path)}>{isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}字段</button>{result?.outputPath ? <button type="button" className="row-link" onClick={() => void getDesktopAPI()?.openPath(result.outputPath ?? "")}>打开</button> : null}<button type="button" className="row-remove" disabled={isAnalyzing || isRunning} onClick={() => removeFile(path)} aria-label={"移除 " + fileNameFromPath(path)}><X size={15} /></button></td>
                      </tr>
                      {isExpanded ? (
                        <tr className="detail-row" key={path + "-detail"}><td colSpan={8}><div className="detail-panel">
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
  );
}
