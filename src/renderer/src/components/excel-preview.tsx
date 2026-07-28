import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronUp, ListRestart, LoaderCircle, Pin, PinOff, Search, Table2, X } from "lucide-react";
import type { DesktopAPI, PriceCheckMapping, PricePreviewCellEdit, PricePreviewWritebackRow } from "../../../preload";
import type { MappingFieldTarget } from "./mapping-editor";
import type {
  ExcelPreviewCandidate,
  ExcelPreviewSearchMatch,
  ExcelPreviewSheet,
  ExcelPreviewWorkbook,
  ExcelPreviewWorkerRequest,
  ExcelPreviewWorkerResponse,
} from "../lib/excel-preview";
import { findExcelPreviewMatches } from "../lib/excel-preview";

type ExcelPreviewProps = {
  api: DesktopAPI | null;
  filePath: string;
  candidates: ExcelPreviewCandidate[];
  activeSheetName: string;
  onActiveSheetChange: (sheetName: string) => void;
  mapping?: PriceCheckMapping | null;
  singleShipmentMatchingEnabled?: boolean;
  matchedOrderRows?: number[];
  writebackRows?: PricePreviewWritebackRow[];
  activeTarget?: MappingFieldTarget | null;
  selectionPrompt?: string;
  onWorkbookChange?: (workbook: ExcelPreviewWorkbook | null) => void;
  onColumnSelect?: (column: number, headerText: string) => void;
  onRowSelect?: (row: number) => void;
  onWritebackRowChange?: (
    row: PricePreviewWritebackRow,
    field: "pricingPrice" | "priceDifference" | "quantity",
  ) => void;
  onUnmatchedRowConfirm?: (sourceRow: number) => void;
  cellEdits?: PricePreviewCellEdit[];
};

type PreviewStatus = "empty" | "loading" | "ready" | "error";
type PricingLookupFilter = {
  sku: string;
  countries: string[];
};

const previewRowHeight = 30;
const previewRowNumberWidth = 52;
const previewColumnWidth = 120;
const previewColumnMinWidth = 64;
const previewColumnMaxWidth = 480;
const skuPairShadeStrengths = [38, 32, 26, 20, 14];
const searchInputMinimumCharacters = 18;
const searchInputPlaceholder = "逗号=且，竖线=或";
const writebackColumnHeaders = ["核价[财务]", "金额差", "数量"] as const;
const totalRowLabels = new Set(["total", "合计", "总计"]);

type SkuPairStyle = CSSProperties & { "--sku-pair-strength": string };

function excelColumnLabel(columnIndex: number): string {
  let value = columnIndex + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function roleLabel(candidate: ExcelPreviewCandidate): string {
  return candidate.roles.map((role) => {
    const label = role === "pricing" ? "核价" : "订单";
    const score = candidate.scores?.[role];
    return score === undefined ? label : `${label} ${score.toFixed(1)} 分`;
  }).join(" · ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function loadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("120MB")) return "文件超过 120MB，无法在应用内预览，请打开原始文件查看";
  if (message.includes("不存在") || message.includes("无法访问")) return "Excel 文件不存在或无法访问";
  if (message.includes("加密")) return "工作簿已加密，无法在应用内预览";
  if (message.includes("损坏") || message.includes("格式不受支持")) return "工作簿损坏或格式不受支持";
  if (message.includes("Worker")) return "当前环境无法启动 Excel 预览组件";
  return "无法读取 Excel 文件，请打开原始文件查看";
}

function mappedColumnClass(
  mapping: PriceCheckMapping | null | undefined,
  sheetName: string,
  column: number,
  singleShipmentMatchingEnabled: boolean,
): string {
  if (!mapping) return "";
  if (sheetName === mapping.orderSheet) {
    if (mapping.skuQtyPairs.some((pair) => (
      pair.skuColumn === column
      || pair.mergedQtyColumn === column
    ))) return " is-sku-qty-column";
    if (mapping.orderPriceColumn === column) return " is-price-column";
    const singleShipmentColumns = singleShipmentMatchingEnabled
      ? mapping.singleShipmentFields?.flatMap((field) => field.columns)
        ?? (mapping.singleShipmentColumn ? [mapping.singleShipmentColumn] : [])
      : [];
    if ([
      mapping.businessOrderNumberColumn,
      mapping.countryCodeColumn,
      mapping.countryEnglishColumn,
      mapping.countryChineseColumn,
      ...singleShipmentColumns,
    ].includes(column)) return " is-mapped-column";
  }
  if (sheetName === mapping.pricingSheet) {
    if (mapping.pricingSkuColumn === column) return " is-sku-column";
    if (mapping.quantityTierColumns.some((tier) => tier.column === column)) return " is-price-column";
    if ([mapping.pricingCountryColumn].includes(column)) return " is-mapped-column";
  }
  return "";
}

function formatPreviewNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(Number(value.toFixed(6)));
}

function normalizeSkuForSearch(value: string): string {
  const normalized = value.trim().replaceAll(/\s/g, "").toLocaleUpperCase();
  const multiplierMatch = /^(.*)\*(\d+)$/.exec(normalized);
  return multiplierMatch && multiplierMatch[1] && Number(multiplierMatch[2]) > 0
    ? multiplierMatch[1]
    : normalized;
}

function parsePreviewQuantity(value: string): number | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized) return null;
  const quantity = Number(normalized);
  return Number.isFinite(quantity) ? quantity : null;
}

function adjacentUnmatchedRow(rows: number[], current: number | null, direction: -1 | 1): number | null {
  if (rows.length === 0) return null;
  const currentIndex = current === null ? -1 : rows.indexOf(current);
  if (direction === -1) return rows[currentIndex <= 0 ? rows.length - 1 : currentIndex - 1];
  return rows[currentIndex < 0 || currentIndex >= rows.length - 1 ? 0 : currentIndex + 1];
}

function skuQtyPairsByPriority(mapping: PriceCheckMapping): PriceCheckMapping["skuQtyPairs"] {
  return [...mapping.skuQtyPairs].sort((left, right) => (
    right.mergedQtyColumn - left.mergedQtyColumn
    || right.skuColumn - left.skuColumn
  ));
}

function isAdjacentDuplicate(
  rows: string[][],
  rowIndex: number,
  columnIndex: number,
  firstDataRowIndex: number,
  normalize: (value: string) => string,
): boolean {
  if (rowIndex < firstDataRowIndex || columnIndex < 0) return false;
  const value = normalize(rows[rowIndex]?.[columnIndex] ?? "");
  if (!value) return false;
  const previous = rowIndex > firstDataRowIndex
    ? normalize(rows[rowIndex - 1]?.[columnIndex] ?? "")
    : "";
  const next = rowIndex + 1 < rows.length
    ? normalize(rows[rowIndex + 1]?.[columnIndex] ?? "")
    : "";
  return value === previous || value === next;
}

function skuPairStyle(mapping: PriceCheckMapping | null | undefined, sheetName: string, column: number): SkuPairStyle | undefined {
  if (!mapping || sheetName !== mapping.orderSheet) return undefined;
  const pairIndex = skuQtyPairsByPriority(mapping)
    .findIndex((pair) => (
      pair.skuColumn === column
      || pair.mergedQtyColumn === column
    ));
  if (pairIndex < 0) return undefined;
  return { "--sku-pair-strength": `${skuPairShadeStrengths[Math.min(pairIndex, skuPairShadeStrengths.length - 1)]}%` };
}

function targetColumn(mapping: PriceCheckMapping | null | undefined, target: MappingFieldTarget | null | undefined): number | null {
  if (!mapping || !target || target.endsWith("HeaderRow")) return null;
  const pairMatch = /^skuQtyPairs\.(\d+)\.(skuColumn|qtyColumn|mergedQtyColumn)$/.exec(target);
  if (pairMatch) {
    return mapping.skuQtyPairs[Number(pairMatch[1])]
      ?.[pairMatch[2] as "skuColumn" | "qtyColumn" | "mergedQtyColumn"] ?? null;
  }
  const tierMatch = /^quantityTierColumns\.(\d+)\.column$/.exec(target);
  if (tierMatch) return mapping.quantityTierColumns[Number(tierMatch[1])]?.column ?? null;
  return (mapping[target as keyof PriceCheckMapping] as number | null | undefined) ?? null;
}

function existingWritebackTotalRow(
  sheet: ExcelPreviewSheet | null,
  mapping: PriceCheckMapping | null | undefined,
  writebackRows: PricePreviewWritebackRow[] | undefined,
): number | null {
  if (!sheet || !mapping?.businessOrderNumberColumn || sheet.truncatedRows || !writebackRows?.length) return null;
  const orderNumberColumnIndex = mapping.businessOrderNumberColumn - sheet.startColumn - 1;
  if (orderNumberColumnIndex < 0 || orderNumberColumnIndex >= sheet.displayedColumnCount) return null;
  const lastOrderRow = Math.max(mapping.orderHeaderRow, ...writebackRows.map((row) => row.sourceRow));
  const candidates = sheet.rows
    .map((row, index) => ({ row, absoluteRow: sheet.startRow + index + 1 }))
    .filter(({ row, absoluteRow }) => (
      absoluteRow > lastOrderRow
      && !(row[orderNumberColumnIndex] ?? "").trim()
      && row.some((value) => value.trim())
    ));
  const labeled = [...candidates].reverse().find(({ row }) => (
    row.some((value) => totalRowLabels.has(value.trim().toLocaleLowerCase()))
  ));
  return labeled?.absoluteRow ?? candidates.at(-1)?.absoluteRow ?? null;
}

function PreviewState({ icon, title, detail, loading = false }: { icon: React.JSX.Element; title: string; detail: string; loading?: boolean }): React.JSX.Element {
  return (
    <div className="excel-preview-state">
      <span className={loading ? "is-loading" : ""}>{icon}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function ExcelPreview({ api, filePath, candidates, activeSheetName, onActiveSheetChange, mapping, singleShipmentMatchingEnabled = false, matchedOrderRows, writebackRows, activeTarget, selectionPrompt, onWorkbookChange, onColumnSelect, onRowSelect, onWritebackRowChange, onUnmatchedRowConfirm, cellEdits }: ExcelPreviewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const unmatchedSwitchRef = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef(0);
  const lastQueriedOrderRowRef = useRef<number | null>(null);
  const orderLookupActiveRef = useRef(false);
  const [status, setStatus] = useState<PreviewStatus>(candidates.length > 0 ? "loading" : "empty");
  const [workbook, setWorkbook] = useState<ExcelPreviewWorkbook | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [columnWidthsBySheet, setColumnWidthsBySheet] = useState<Record<string, number[]>>({});
  const [pinnedColumnsBySheet, setPinnedColumnsBySheet] = useState<Record<string, number[]>>({});
  const [resizingColumn, setResizingColumn] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [searchPreferredColumns, setSearchPreferredColumns] = useState<number[]>([]);
  const [pricingLookupFilter, setPricingLookupFilter] = useState<PricingLookupFilter | null>(null);
  const [unmatchedNavigationEnabled, setUnmatchedNavigationEnabled] = useState(false);
  const [activeUnmatchedRow, setActiveUnmatchedRow] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  // 默认预览截断；开启「未匹配定位」或手动点「加载全部」时再拉全量
  const [loadAll, setLoadAll] = useState(false);
  const [pendingOrderReturnRow, setPendingOrderReturnRow] = useState<number | null>(null);
  const [editingWritebackCell, setEditingWritebackCell] = useState<{
    sourceRow: number;
    columnIndex: number;
    value: string;
  } | null>(null);
  const [selectedCell, setSelectedCell] = useState<{
    sheetName: string;
    row: number;
    column: number;
  } | null>(null);

  useEffect(() => {
    setSelectedRow(null);
    setSelectedCell(null);
  }, [filePath, activeSheetName]);

  useEffect(() => {
    setColumnWidthsBySheet({});
    setPinnedColumnsBySheet({});
    setResizingColumn(null);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchPreferredColumns([]);
    setPricingLookupFilter(null);
    setUnmatchedNavigationEnabled(false);
    setActiveUnmatchedRow(null);
    setLoadAll(false);
    lastQueriedOrderRowRef.current = null;
    setPendingOrderReturnRow(null);
    setEditingWritebackCell(null);
    setSelectedCell(null);
    orderLookupActiveRef.current = false;
  }, [filePath]);

  const previewCandidates = useMemo(() => {
    if (!loadAll || !mapping) return candidates;
    const selectedSheetNames = new Set([mapping.orderSheet, mapping.pricingSheet]);
    const selectedCandidates = candidates.filter((candidate) => selectedSheetNames.has(candidate.name));
    return selectedCandidates.length > 0 ? selectedCandidates : candidates;
  }, [candidates, loadAll, mapping?.orderSheet, mapping?.pricingSheet]);

  const selectRow = (row: number): void => {
    setSelectedRow(row);
    onRowSelect?.(row);
  };

  useEffect(() => {
    setWorkbook(null);
    setFileSize(null);
    setErrorMessage("");
    if (candidates.length === 0) {
      setStatus("empty");
      return;
    }
    if (!api) {
      setStatus("error");
      setErrorMessage("桌面文件接口不可用");
      return;
    }

    let cancelled = false;
    let worker: Worker | null = null;
    const requestId = ++requestIdRef.current;
    setStatus("loading");

    void api.readExcelPreviewFile(filePath).then((source) => {
      if (cancelled) return;
      setFileSize(source.size);
      if (typeof Worker === "undefined") throw new Error("Worker is unavailable");
      worker = new Worker(new URL("../workers/excel-preview.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<ExcelPreviewWorkerResponse>): void => {
        if (cancelled || event.data.requestId !== requestId) return;
        if (event.data.ok) {
          setWorkbook(event.data.workbook);
          setStatus("ready");
        } else {
          setErrorMessage(event.data.message);
          setStatus("error");
        }
      };
      worker.onerror = (): void => {
        if (cancelled) return;
        setErrorMessage("Excel 预览组件运行失败");
        setStatus("error");
      };
      const buffer = source.bytes.slice().buffer;
      const request: ExcelPreviewWorkerRequest = { requestId, buffer, candidates: previewCandidates, loadAll };
      worker.postMessage(request, [buffer]);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setErrorMessage(loadErrorMessage(error));
      setStatus("error");
    });

    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [api, filePath, loadAll, previewCandidates]);

  useEffect(() => {
    onWorkbookChange?.(workbook);
  }, [onWorkbookChange, workbook]);

  const activeSheet = useMemo<ExcelPreviewSheet | null>(() => (
    workbook?.sheets.find((sheet) => sheet.name === activeSheetName) ?? null
  ), [activeSheetName, workbook]);
  const showsWritebackColumns = Boolean(activeSheet && mapping && activeSheet.name === mapping.orderSheet);
  const writebackTotalRow = showsWritebackColumns
    ? existingWritebackTotalRow(activeSheet, mapping, writebackRows)
    : null;
  const previewRowCount = activeSheet?.rows.length ?? 0;
  const searchMatches = useMemo<ExcelPreviewSearchMatch[]>(() => {
    let matches = findExcelPreviewMatches(activeSheet?.rows ?? [], searchQuery);
    if (activeSheet && activeSheet.name === mapping?.pricingSheet && pricingLookupFilter) {
      const skuColumnIndex = mapping.pricingSkuColumn - activeSheet.startColumn - 1;
      const countryColumnIndex = mapping.pricingCountryColumn - activeSheet.startColumn - 1;
      const countries = new Set(pricingLookupFilter.countries.map((country) => country.trim().toLocaleLowerCase()));
      matches = matches.filter((match) => {
        const row = activeSheet.rows[match.rowIndex] ?? [];
        return normalizeSkuForSearch(row[skuColumnIndex] ?? "") === pricingLookupFilter.sku
          && countries.has((row[countryColumnIndex] ?? "").trim().toLocaleLowerCase());
      });
    }
    if (!activeSheet || activeSheet.name !== mapping?.pricingSheet || searchPreferredColumns.length === 0) return matches;
    const preferredColumnIndexes = searchPreferredColumns
      .map((column) => column - activeSheet.startColumn - 1)
      .filter((columnIndex) => columnIndex >= 0 && columnIndex < activeSheet.displayedColumnCount);
    return matches.map((match) => {
      const row = activeSheet.rows[match.rowIndex] ?? [];
      const columnIndex = preferredColumnIndexes.find((index) => row[index]?.trim());
      return columnIndex === undefined ? match : { ...match, columnIndex };
    });
  }, [activeSheet, mapping?.pricingCountryColumn, mapping?.pricingSheet, mapping?.pricingSkuColumn, pricingLookupFilter, searchPreferredColumns, searchQuery]);
  const activeSearchMatch = searchMatches.length > 0
    ? searchMatches[activeSearchMatchIndex % searchMatches.length]
    : null;
  const searchMatchedRowSet = useMemo(() => new Set(searchMatches.map((match) => match.rowIndex)), [searchMatches]);
  const matchedOrderRowSet = useMemo(() => new Set(matchedOrderRows ?? []), [matchedOrderRows]);
  const unmatchedOrderRows = useMemo(() => Array.from(new Set((writebackRows ?? [])
    .map((row) => row.sourceRow)
    .filter((row) => !matchedOrderRowSet.has(row))))
    .sort((left, right) => left - right), [matchedOrderRowSet, writebackRows]);
  const toggleUnmatchedNavigation = useCallback((): void => {
    if (activeSheetName !== mapping?.orderSheet || unmatchedOrderRows.length === 0) return;
    setUnmatchedNavigationEnabled((current) => {
      const enabling = !current;
      // 开启未匹配定位时加载全部；已加载则不重复触发
      if (enabling && !loadAll) setLoadAll(true);
      return enabling;
    });
    setActiveUnmatchedRow(null);
  }, [activeSheetName, loadAll, mapping?.orderSheet, unmatchedOrderRows.length]);
  const confirmUnmatchedRow = useCallback((): void => {
    const sourceRow = activeUnmatchedRow ?? unmatchedOrderRows[0] ?? null;
    if (sourceRow === null) return;
    setActiveUnmatchedRow(sourceRow);
    onUnmatchedRowConfirm?.(sourceRow);
  }, [activeUnmatchedRow, onUnmatchedRowConfirm, unmatchedOrderRows]);
  const shouldVirtualizeRows = previewRowCount > 100;
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualizeRows ? previewRowCount : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => previewRowHeight,
    overscan: 10,
  });

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
    scrollRef.current.scrollLeft = 0;
    rowVirtualizer.measure();
  }, [activeSheetName]);

  useEffect(() => {
    const targetRow = pendingOrderReturnRow;
    if (!activeSheet || activeSheetName !== mapping?.orderSheet || targetRow === null) return;
    setPendingOrderReturnRow(null);
    const targetIndex = targetRow - activeSheet.startRow - 1;
    if (targetIndex < 0 || targetIndex >= activeSheet.rows.length) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    if (shouldVirtualizeRows) {
      rowVirtualizer.scrollToIndex(targetIndex, { align: "center" });
    } else {
      scrollElement.scrollTop = Math.max(0, targetIndex * previewRowHeight - scrollElement.clientHeight / 2);
    }
  }, [activeSheet, activeSheetName, mapping?.orderSheet, pendingOrderReturnRow, rowVirtualizer, shouldVirtualizeRows]);

  useEffect(() => {
    if (!unmatchedNavigationEnabled || activeSheetName !== mapping?.orderSheet || unmatchedOrderRows.length === 0) {
      setActiveUnmatchedRow(null);
      return;
    }
    const handleUnmatchedNavigation = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.matches("button, input, textarea, select, [contenteditable='true']")
          || target.closest("button, input, textarea, select, [contenteditable='true']"))) return;
      if (document.querySelector(".issue-details-dialog[role='dialog'][aria-modal='true']")) return;
      event.preventDefault();
      if (event.key === "Enter") {
        confirmUnmatchedRow();
        return;
      }
      setActiveUnmatchedRow((current) => {
        return adjacentUnmatchedRow(unmatchedOrderRows, current, event.key === "ArrowUp" ? -1 : 1);
      });
    };
    document.addEventListener("keydown", handleUnmatchedNavigation);
    return () => document.removeEventListener("keydown", handleUnmatchedNavigation);
  }, [activeSheetName, confirmUnmatchedRow, mapping?.orderSheet, unmatchedNavigationEnabled, unmatchedOrderRows]);

  useEffect(() => {
    if (!unmatchedNavigationEnabled
      || activeSheetName !== mapping?.orderSheet
      || unmatchedOrderRows.length === 0) return;
    const frame = requestAnimationFrame(() => unmatchedSwitchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeSheetName, mapping?.orderSheet, unmatchedNavigationEnabled, unmatchedOrderRows.length]);

  useEffect(() => {
    if (!activeSheet || activeSheetName !== mapping?.orderSheet || activeUnmatchedRow === null) return;
    const targetIndex = activeUnmatchedRow - activeSheet.startRow - 1;
    if (targetIndex < 0 || targetIndex >= activeSheet.rows.length) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    if (shouldVirtualizeRows) {
      rowVirtualizer.scrollToIndex(targetIndex, { align: "center" });
    } else {
      scrollElement.scrollTop = Math.max(0, targetIndex * previewRowHeight - scrollElement.clientHeight / 2);
    }
  }, [activeSheet, activeSheetName, activeUnmatchedRow, mapping?.orderSheet, rowVirtualizer, shouldVirtualizeRows]);

  useEffect(() => {
    setActiveSearchMatchIndex(0);
  }, [activeSheetName, searchQuery]);

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        if (!searchOpen && !activeSheet) return;
        event.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery("");
          setSearchPreferredColumns([]);
          setPricingLookupFilter(null);
        } else {
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        }
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        setSearchQuery("");
        setSearchPreferredColumns([]);
        setPricingLookupFilter(null);
      }
    };
    document.addEventListener("keydown", handleFindShortcut);
    return () => document.removeEventListener("keydown", handleFindShortcut);
  }, [activeSheet, searchOpen]);

  useEffect(() => {
    const handleUnmatchedShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "e") return;
      if (activeSheetName !== mapping?.orderSheet || unmatchedOrderRows.length === 0) return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.matches("input, textarea, select, [contenteditable='true']")
          || target.closest("input, textarea, select, [contenteditable='true']"))) return;
      event.preventDefault();
      toggleUnmatchedNavigation();
      requestAnimationFrame(() => unmatchedSwitchRef.current?.focus());
    };
    document.addEventListener("keydown", handleUnmatchedShortcut);
    return () => document.removeEventListener("keydown", handleUnmatchedShortcut);
  }, [activeSheetName, mapping?.orderSheet, toggleUnmatchedNavigation, unmatchedOrderRows.length]);

  const sourceColumnCount = activeSheet?.displayedColumnCount ?? 0;
  const columnCount = sourceColumnCount + (showsWritebackColumns ? writebackColumnHeaders.length : 0);
  const writebackBySourceRow = useMemo(
    () => new Map((writebackRows ?? []).map((row) => [row.sourceRow, row])),
    [writebackRows],
  );
  const cellEditByLocation = useMemo(() => new Map(
    (cellEdits ?? []).map((edit) => [`${edit.sheetName}\u0000${edit.row}\u0000${edit.column}`, edit]),
  ), [cellEdits]);
  const writebackTotals = useMemo(() => (writebackRows ?? []).reduce((total, row) => ({
    pricingPrice: total.pricingPrice + (row.pricingPrice ?? 0),
    priceDifference: total.priceDifference + (row.priceDifference ?? 0),
    quantity: total.quantity + (row.quantity ?? 0),
  }), { pricingPrice: 0, priceDifference: 0, quantity: 0 }), [writebackRows]);
  const isWritebackColumn = (columnIndex: number): boolean => showsWritebackColumns && columnIndex >= sourceColumnCount;
  const orderPriceColumnIndex = showsWritebackColumns && mapping?.orderPriceColumn
    ? mapping.orderPriceColumn - (activeSheet?.startColumn ?? 0) - 1
    : -1;
  const writebackInsertionIndex = orderPriceColumnIndex >= 0 && orderPriceColumnIndex < sourceColumnCount
    ? orderPriceColumnIndex + 1
    : sourceColumnCount;
  const displayedAbsoluteColumn = (columnIndex: number): number => {
    const sourceAbsoluteColumn = (activeSheet?.startColumn ?? 0) + columnIndex + 1;
    if (!showsWritebackColumns) return sourceAbsoluteColumn;
    if (isWritebackColumn(columnIndex)) {
      return (mapping?.orderPriceColumn ?? sourceAbsoluteColumn) + columnIndex - sourceColumnCount + 1;
    }
    return columnIndex >= writebackInsertionIndex
      ? sourceAbsoluteColumn + writebackColumnHeaders.length
      : sourceAbsoluteColumn;
  };
  const cellValue = (row: string[], columnIndex: number, absoluteRow: number): string => {
    if (!isWritebackColumn(columnIndex)) {
      const absoluteColumn = (activeSheet?.startColumn ?? 0) + columnIndex + 1;
      return cellEditByLocation.get(`${activeSheetName}\u0000${absoluteRow}\u0000${absoluteColumn}`)?.value
        ?? row[columnIndex]
        ?? "";
    }
    const writebackColumnIndex = columnIndex - sourceColumnCount;
    if (absoluteRow === mapping?.orderHeaderRow) return writebackColumnHeaders[writebackColumnIndex] ?? "";
    const writeback = writebackBySourceRow.get(absoluteRow);
    if (!writeback) return "";
    if (writebackColumnIndex === 0) return formatPreviewNumber(writeback.pricingPrice);
    if (writebackColumnIndex === 1) return formatPreviewNumber(writeback.priceDifference);
    return writeback.quantity === null ? "" : String(writeback.quantity);
  };
  const columnWidths = Array.from({ length: columnCount }, (_, index) => columnWidthsBySheet[activeSheetName]?.[index] ?? previewColumnWidth);
  const pinnedColumnIndexes = (pinnedColumnsBySheet[activeSheetName] ?? []).filter((columnIndex) => columnIndex < columnCount);
  const naturalColumnIndexes = Array.from({ length: sourceColumnCount }, (_, index) => index);
  if (showsWritebackColumns) {
    naturalColumnIndexes.splice(
      writebackInsertionIndex,
      0,
      ...writebackColumnHeaders.map((_, index) => sourceColumnCount + index),
    );
  }
  const orderedColumnIndexes = [...pinnedColumnIndexes, ...naturalColumnIndexes.filter((columnIndex) => !pinnedColumnIndexes.includes(columnIndex))];
  const gridWidth = previewRowNumberWidth + columnWidths.reduce((total, width) => total + width, 0);
  const renderedRows = shouldVirtualizeRows
    ? rowVirtualizer.getVirtualItems()
    : Array.from({ length: previewRowCount }, (_, index) => ({ index, key: index, size: previewRowHeight, start: index * previewRowHeight }));
  const rowsHeight = shouldVirtualizeRows ? rowVirtualizer.getTotalSize() : previewRowCount * previewRowHeight;
  const gridStyle = {
    width: `${gridWidth}px`,
    gridTemplateColumns: `${previewRowNumberWidth}px ${orderedColumnIndexes.map((columnIndex) => `${columnWidths[columnIndex]}px`).join(" ")}`,
  } satisfies CSSProperties;
  const activeColumn = targetColumn(mapping, activeTarget);
  const activeHeaderRow = activeSheetName === mapping?.orderSheet ? mapping.orderHeaderRow : activeSheetName === mapping?.pricingSheet ? mapping.pricingHeaderRow : null;
  const selectionHeaderRow = activeTarget?.startsWith("quantityTierColumns") ? mapping?.pricingQuantityHeaderRow ?? mapping?.pricingHeaderRow ?? null : activeHeaderRow;
  const selectingColumn = Boolean(activeTarget && !activeTarget.endsWith("HeaderRow"));
  const frozenHeaderIndex = activeSheet && activeHeaderRow ? activeHeaderRow - activeSheet.startRow - 1 : -1;
  const frozenHeaderRow = activeSheet && frozenHeaderIndex >= 0 && frozenHeaderIndex < activeSheet.rows.length ? activeSheet.rows[frozenHeaderIndex] : null;
  const highestPrioritySkuQtyPair = mapping && activeSheetName === mapping.orderSheet
    ? skuQtyPairsByPriority(mapping)[0] ?? null
    : null;

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !activeSearchMatch) return;
    if (shouldVirtualizeRows) {
      rowVirtualizer.scrollToIndex(activeSearchMatch.rowIndex, { align: "center" });
    } else {
      scrollElement.scrollTop = Math.max(0, activeSearchMatch.rowIndex * previewRowHeight - scrollElement.clientHeight / 2);
    }
    if (!pinnedColumnIndexes.includes(activeSearchMatch.columnIndex)) {
      const orderedPosition = orderedColumnIndexes.indexOf(activeSearchMatch.columnIndex);
      const targetLeft = previewRowNumberWidth + orderedColumnIndexes
        .slice(0, orderedPosition)
        .reduce((total, columnIndex) => total + columnWidths[columnIndex], 0);
      const targetWidth = columnWidths[activeSearchMatch.columnIndex] ?? previewColumnWidth;
      scrollElement.scrollLeft = Math.max(0, targetLeft - (scrollElement.clientWidth - targetWidth) / 2);
    }
    // 仅在搜索目标变化时定位，布局变化和滚动重绘不能抢占用户当前视图。
  }, [activeSearchMatch]);

  const moveSearchMatch = (direction: 1 | -1): void => {
    if (searchMatches.length === 0) return;
    setActiveSearchMatchIndex((current) => (current + direction + searchMatches.length) % searchMatches.length);
  };

  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchPreferredColumns([]);
    setPricingLookupFilter(null);
  };

  const changePreviewSheet = (sheetName: string): void => {
    if (sheetName === mapping?.orderSheet && orderLookupActiveRef.current && lastQueriedOrderRowRef.current !== null) {
      closeSearch();
      setPendingOrderReturnRow(lastQueriedOrderRowRef.current);
      orderLookupActiveRef.current = false;
    }
    onActiveSheetChange(sheetName);
  };

  const searchPricingForOrderRow = (row: string[], absoluteRow: number): void => {
    if (!mapping || !activeSheet || activeSheet.name !== mapping.orderSheet || absoluteRow <= mapping.orderHeaderRow) return;
    const valueAt = (absoluteColumn: number | null | undefined): string => {
      if (!absoluteColumn) return "";
      return row[absoluteColumn - activeSheet.startColumn - 1]?.trim() ?? "";
    };
    const countries = Array.from(new Set([mapping.countryCodeColumn, mapping.countryEnglishColumn, mapping.countryChineseColumn]
      .map(valueAt)
      .filter(Boolean)));
    const sku = normalizeSkuForSearch(skuQtyPairsByPriority(mapping)
      .map((pair) => valueAt(pair.skuColumn))
      .find(Boolean) ?? "");
    const quantity = writebackBySourceRow.get(absoluteRow)?.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity)) return;
    const priceColumn = mapping.quantityTierColumns.find((tier) => tier.quantity === quantity)?.column;
    const termGroups = [sku, countries.join(" | ")].filter(Boolean);
    if (termGroups.length === 0) return;
    setSearchQuery(termGroups.join(", "));
    setPricingLookupFilter({ sku, countries });
    setSearchPreferredColumns([priceColumn, mapping.pricingSkuColumn, mapping.pricingCountryColumn]
      .filter((column): column is number => typeof column === "number" && column > 0));
    setSearchOpen(true);
    setActiveSearchMatchIndex(0);
    if (!loadAll) setLoadAll(true);
    lastQueriedOrderRowRef.current = absoluteRow;
    orderLookupActiveRef.current = true;
    onActiveSheetChange(mapping.pricingSheet);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const resizeColumn = (columnIndex: number, width: number): void => {
    const nextWidth = Math.min(previewColumnMaxWidth, Math.max(previewColumnMinWidth, Math.round(width)));
    setColumnWidthsBySheet((current) => {
      const widths = Array.from({ length: columnCount }, (_, index) => current[activeSheetName]?.[index] ?? previewColumnWidth);
      widths[columnIndex] = nextWidth;
      return { ...current, [activeSheetName]: widths };
    });
  };

  const togglePinnedColumn = (columnIndex: number): void => {
    setPinnedColumnsBySheet((current) => {
      const pinned = current[activeSheetName] ?? [];
      return { ...current, [activeSheetName]: pinned.includes(columnIndex) ? pinned.filter((index) => index !== columnIndex) : [...pinned, columnIndex] };
    });
  };

  const pinnedColumnStyle = (columnIndex: number): CSSProperties | undefined => {
    const pinnedPosition = pinnedColumnIndexes.indexOf(columnIndex);
    if (pinnedPosition < 0) return undefined;
    const left = previewRowNumberWidth + pinnedColumnIndexes.slice(0, pinnedPosition).reduce((total, pinnedIndex) => total + columnWidths[pinnedIndex], 0);
    return { left: `${left}px` };
  };

  const startColumnResize = (event: ReactPointerEvent<HTMLSpanElement>, columnIndex: number): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[columnIndex] ?? previewColumnWidth;
    setResizingColumn(columnIndex);
    const handlePointerMove = (moveEvent: PointerEvent): void => resizeColumn(columnIndex, startWidth + moveEvent.clientX - startX);
    const stopResize = (): void => {
      setResizingColumn(null);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  const commitWritebackEdit = (): void => {
    if (!editingWritebackCell) return;
    const current = writebackBySourceRow.get(editingWritebackCell.sourceRow);
    if (!current) {
      setEditingWritebackCell(null);
      return;
    }
    const trimmed = editingWritebackCell.value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed.replaceAll(",", ""));
    if (parsed !== null && !Number.isFinite(parsed)) return;
    if (editingWritebackCell.columnIndex === 2 && parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) return;
    const next = { ...current };
    const sourceRow = activeSheet?.rows[editingWritebackCell.sourceRow - (activeSheet?.startRow ?? 0) - 1];
    const sourcePriceColumnIndex = mapping?.orderPriceColumn
      ? mapping.orderPriceColumn - (activeSheet?.startColumn ?? 0) - 1
      : -1;
    const originalPrice = sourceRow && sourcePriceColumnIndex >= 0
      ? parsePreviewQuantity(cellValue(sourceRow, sourcePriceColumnIndex, editingWritebackCell.sourceRow))
      : null;
    let editedField: "pricingPrice" | "priceDifference" | "quantity";
    if (editingWritebackCell.columnIndex === 0) {
      editedField = "pricingPrice";
      next.pricingPrice = parsed;
      if (parsed !== null && originalPrice !== null) {
        next.priceDifference = Number((parsed - originalPrice).toFixed(6));
      }
    } else if (editingWritebackCell.columnIndex === 1) {
      editedField = "priceDifference";
      next.priceDifference = parsed;
      if (parsed !== null && originalPrice !== null) {
        next.pricingPrice = Number((originalPrice + parsed).toFixed(6));
      }
    } else {
      editedField = "quantity";
      next.quantity = parsed;
      if (parsed !== null) next.quantityError = null;
    }
    onWritebackRowChange?.(next, editedField);
    setEditingWritebackCell(null);
  };

  // 稳定 ref：仅在输入框挂载时聚焦全选，避免每次按键重跑
  const focusEditor = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    requestAnimationFrame(() => {
      if (document.activeElement === input) return;
      input.focus();
      input.setSelectionRange(0, input.value.length);
    });
  }, []);

  return (
    <section className={`excel-preview-panel${activeTarget ? " is-selecting" : ""}`} aria-label="Excel 预览">
      <div className="excel-preview-tabs" role="tablist" aria-label="候选 Sheet">
        {previewCandidates.map((candidate) => (
          <button
            type="button"
            role="tab"
            aria-selected={candidate.name === activeSheetName}
            className={candidate.name === activeSheetName ? "is-active" : ""}
            onClick={() => changePreviewSheet(candidate.name)}
            key={candidate.name}
          >
            <strong>{candidate.name}</strong><span>{roleLabel(candidate)}</span>
          </button>
        ))}
        <button
          ref={unmatchedSwitchRef}
          type="button"
          role="switch"
          aria-checked={unmatchedNavigationEnabled}
          aria-label="未匹配定位"
          aria-keyshortcuts="Control+E ArrowUp ArrowDown Enter"
          title="Ctrl+E 开关；开启后用 ↑↓ 选择，Enter 查看详情"
          className={`excel-preview-unmatched-switch${unmatchedNavigationEnabled ? " is-enabled" : ""}`}
          disabled={activeSheetName !== mapping?.orderSheet || unmatchedOrderRows.length === 0}
          onClick={toggleUnmatchedNavigation}
          onKeyDown={(event) => {
            if (!unmatchedNavigationEnabled) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              confirmUnmatchedRow();
              return;
            }
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            event.stopPropagation();
            setActiveUnmatchedRow((current) => adjacentUnmatchedRow(
              unmatchedOrderRows,
              current,
              event.key === "ArrowUp" ? -1 : 1,
            ));
          }}
        >
          <i aria-hidden="true" />
          <strong>未匹配定位</strong>
          <span>↑↓ {unmatchedOrderRows.length}</span>
        </button>
        <div className="excel-preview-toolbar">
          <button
            type="button"
            className="excel-preview-load-all"
            aria-label="加载全部数据"
            title="按文件路径重新读取当前订单 Sheet 和核价 Sheet 的全部数据"
            disabled={!activeSheet || loadAll || status === "loading"}
            onClick={() => {
              // 已加载全部时不重复触发
              if (!loadAll) setLoadAll(true);
            }}
          >
            {status === "loading" && loadAll ? <LoaderCircle className="is-loading" /> : <ListRestart />}
            <span>{status === "loading" && loadAll ? "加载中" : loadAll ? "已加载全部" : "加载全部"}</span>
          </button>
          <div className={`excel-preview-search${searchOpen ? " is-open" : ""}`}>
            {!searchOpen ? (
              <button type="button" className="excel-preview-search-toggle" aria-label="搜索表格" title="搜索表格（Ctrl+F）" disabled={!activeSheet} onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInputRef.current?.focus()); }}>
                <Search /><kbd>Ctrl F</kbd>
              </button>
            ) : (
              <>
                <Search className="excel-preview-search-icon" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="search"
                  aria-label="搜索表格数据"
                  placeholder={searchInputPlaceholder}
                  size={Math.max(searchInputMinimumCharacters, Array.from(searchQuery).length + 1)}
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchPreferredColumns([]);
                    setPricingLookupFilter(null);
                    setSearchQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : event.key === "Enter" ? event.shiftKey ? -1 : 1 : null;
                    if (direction === null) return;
                    event.preventDefault();
                    moveSearchMatch(direction);
                  }}
                />
                <output className="excel-preview-search-count" aria-live="polite">
                  {searchQuery ? `${searchMatches.length ? activeSearchMatchIndex % searchMatches.length + 1 : 0}/${searchMatches.length}` : "0/0"}
                </output>
                <div className="excel-preview-search-actions">
                  <button type="button" className="excel-preview-search-action" aria-label="上一个匹配" title="上一个匹配（↑ / Shift+Enter）" disabled={searchMatches.length === 0} onClick={() => moveSearchMatch(-1)}><ChevronUp /></button>
                  <button type="button" className="excel-preview-search-action" aria-label="下一个匹配" title="下一个匹配（↓ / Enter）" disabled={searchMatches.length === 0} onClick={() => moveSearchMatch(1)}><ChevronDown /></button>
                  <button type="button" className="excel-preview-search-action" aria-label="关闭搜索" title="关闭搜索（Esc）" onClick={closeSearch}><X /></button>
                </div>
              </>
            )}
          </div>
          {fileSize !== null ? <em className="excel-preview-filesize" title="文件大小">{formatBytes(fileSize)}</em> : null}
        </div>
      </div>
      {activeTarget ? <div className="excel-preview-selection-prompt" role="status"><strong>{selectionPrompt}</strong><span>{activeTarget.endsWith("HeaderRow") ? "点击左侧行号" : "点击目标列中的任意单元格"}</span><kbd>Esc 取消</kbd></div> : null}
      <div className="excel-preview-body">
        {status === "empty" ? <PreviewState icon={<Table2 />} title="暂无候选 Sheet" detail="完成文件分析后将在此显示订单与核价候选表" /> : null}
        {status === "loading" ? <PreviewState icon={<LoaderCircle />} title="正在读取工作簿" detail="仅解析候选 Sheet 与前 500 行" loading /> : null}
        {status === "error" ? <PreviewState icon={<AlertTriangle />} title="无法预览工作簿" detail={errorMessage} /> : null}
        {status === "ready" && !activeSheet ? <PreviewState icon={<AlertTriangle />} title="候选 Sheet 不存在" detail="工作簿中未找到该候选表，请重新分析文件" /> : null}
        {status === "ready" && activeSheet && columnCount === 0 ? <PreviewState icon={<Table2 />} title="Sheet 内容为空" detail="该候选表没有可显示的单元格" /> : null}
        {status === "ready" && activeSheet && columnCount > 0 ? (
          <div className="excel-preview-table-frame">
            <div className="excel-preview-scroll" ref={scrollRef}>
              <div className="excel-preview-grid" style={{ width: `${gridWidth}px` }} onMouseLeave={() => setHoveredColumn(null)}>
              <div className="excel-preview-header" style={gridStyle}>
                <span className="excel-preview-corner">#</span>
                {orderedColumnIndexes.map((columnIndex) => {
                  const derived = isWritebackColumn(columnIndex);
                  const absoluteColumn = activeSheet.startColumn + columnIndex + 1;
                  const displayColumnLabel = excelColumnLabel(displayedAbsoluteColumn(columnIndex) - 1);
                  return (
                  <span
                    className={`${derived ? "is-writeback-column" : mappedColumnClass(mapping, activeSheet.name, absoluteColumn, singleShipmentMatchingEnabled)}${activeColumn === absoluteColumn ? " is-active-column" : ""}${hoveredColumn === absoluteColumn ? " is-hover-column" : ""}${selectingColumn && !derived ? " is-selectable-column" : ""}${pinnedColumnIndexes.includes(columnIndex) ? " is-pinned-column" : ""}`}
                    style={{ ...pinnedColumnStyle(columnIndex), ...(!derived ? skuPairStyle(mapping, activeSheet.name, absoluteColumn) : undefined) }}
                    data-column-label={displayColumnLabel}
                    onMouseEnter={() => selectingColumn && !derived && setHoveredColumn(absoluteColumn)}
                    onClick={() => selectingColumn && !derived && onColumnSelect?.(absoluteColumn, selectionHeaderRow ? activeSheet.rows[selectionHeaderRow - activeSheet.startRow - 1]?.[columnIndex] ?? "" : "")}
                    key={columnIndex}
                  >
                    {displayColumnLabel}
                    <button
                      type="button"
                      className="excel-preview-column-pin"
                      aria-label={`${pinnedColumnIndexes.includes(columnIndex) ? "取消冻结" : "冻结"} ${displayColumnLabel} 列`}
                      title={pinnedColumnIndexes.includes(columnIndex) ? "取消冻结列" : "冻结到左侧"}
                      onClick={(pinEvent) => { pinEvent.stopPropagation(); togglePinnedColumn(columnIndex); }}
                    >{pinnedColumnIndexes.includes(columnIndex) ? <PinOff /> : <Pin />}</button>
                    <span
                      className={`excel-preview-column-resizer${resizingColumn === columnIndex ? " is-resizing" : ""}`}
                      role="separator"
                      tabIndex={0}
                      aria-label={`调整 ${displayColumnLabel} 列宽`}
                      aria-orientation="vertical"
                      aria-valuemin={previewColumnMinWidth}
                      aria-valuemax={previewColumnMaxWidth}
                      aria-valuenow={columnWidths[columnIndex]}
                      title="拖动调整列宽，双击恢复默认"
                      onClick={(resizeEvent) => resizeEvent.stopPropagation()}
                      onDoubleClick={(resizeEvent) => { resizeEvent.stopPropagation(); resizeColumn(columnIndex, previewColumnWidth); }}
                      onPointerDown={(resizeEvent) => startColumnResize(resizeEvent, columnIndex)}
                      onKeyDown={(resizeEvent) => {
                        const delta = resizeEvent.key === "ArrowLeft" ? -8 : resizeEvent.key === "ArrowRight" ? 8 : 0;
                        if (!delta) return;
                        resizeEvent.preventDefault();
                        resizeEvent.stopPropagation();
                        resizeColumn(columnIndex, (columnWidths[columnIndex] ?? previewColumnWidth) + delta);
                      }}
                    />
                  </span>
                  );
                })}
              </div>
              {frozenHeaderRow ? <div className={`excel-preview-row excel-preview-frozen-header${searchMatchedRowSet.has(frozenHeaderIndex) ? " is-search-matched-row" : ""}${selectedRow === activeHeaderRow ? " is-selected-row" : ""}`} style={gridStyle} aria-label={`冻结表头，第 ${activeHeaderRow} 行`}>
                <span
                  className="excel-preview-row-number is-header-row"
                  tabIndex={0}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    selectRow(activeHeaderRow ?? 1);
                  }}
                  onBlur={() => setSelectedRow((row) => row === (activeHeaderRow ?? 1) ? null : row)}
                >{activeHeaderRow}</span>
                {orderedColumnIndexes.map((columnIndex) => {
                  const cell = cellValue(frozenHeaderRow, columnIndex, activeHeaderRow ?? 0);
                  const headerDisplay = cell.trim() ? cell : "空表头";
                  const absoluteColumn = activeSheet.startColumn + columnIndex + 1;
                  const derived = isWritebackColumn(columnIndex);
                  const mappedClass = derived ? "" : mappedColumnClass(mapping, activeSheet.name, absoluteColumn, singleShipmentMatchingEnabled);
                  return <span
                    className={`${derived ? "is-writeback-column" : mappedClass}${activeColumn === absoluteColumn ? " is-active-column" : ""} is-header-cell${cell.trim() ? "" : " is-empty-header"}${hoveredColumn === absoluteColumn ? " is-hover-column" : ""}${selectingColumn && !derived ? " is-selectable-column" : ""}${pinnedColumnIndexes.includes(columnIndex) ? " is-pinned-column" : ""}${activeSearchMatch?.rowIndex === frozenHeaderIndex && activeSearchMatch.columnIndex === columnIndex ? " is-search-match" : ""}`}
                    style={{ ...pinnedColumnStyle(columnIndex), ...(!derived ? skuPairStyle(mapping, activeSheet.name, absoluteColumn) : undefined) }}
                    title={headerDisplay}
                    onMouseEnter={() => selectingColumn && !derived && setHoveredColumn(absoluteColumn)}
                    onClick={() => {
                      if (selectingColumn && !derived) {
                        // 映射侧用真实空串；展示文案仅 UI 用
                        onColumnSelect?.(absoluteColumn, cell.trim());
                      }
                    }}
                    key={columnIndex}
                  >{headerDisplay}</span>;
                })}
              </div> : null}
              <div className="excel-preview-rows" style={{ height: `${rowsHeight}px`, width: `${gridWidth}px` }}>
                {renderedRows.map((virtualRow) => {
                  const row = activeSheet.rows[virtualRow.index] ?? [];
                  const absoluteRow = activeSheet.startRow + virtualRow.index + 1;
                  const isWritebackTotalRow = writebackTotalRow === absoluteRow;
                  const isMatchedOrderRow = activeSheet.name === mapping?.orderSheet && matchedOrderRowSet.has(absoluteRow);
                  const isActiveUnmatchedRow = activeSheet.name === mapping?.orderSheet && activeUnmatchedRow === absoluteRow;
                  const isSearchMatchedRow = searchMatchedRowSet.has(virtualRow.index);
                  const orderColumnIndex = mapping?.businessOrderNumberColumn
                    ? mapping.businessOrderNumberColumn - activeSheet.startColumn - 1
                    : -1;
                  const firstDataRowIndex = mapping
                    ? mapping.orderHeaderRow - activeSheet.startRow
                    : activeSheet.rows.length;
                  const isHeaderRow = !isWritebackTotalRow && activeHeaderRow === absoluteRow;
                  return (
                    <div
                      className={`excel-preview-row${isWritebackTotalRow ? " excel-preview-total-row" : ""}${isSearchMatchedRow ? " is-search-matched-row" : ""}${isActiveUnmatchedRow ? " is-unmatched-target-row" : ""}${selectedRow === absoluteRow ? " is-selected-row" : ""}`}
                      style={{ ...gridStyle, height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                      key={virtualRow.key}
                    >
                      <span
                        className={`excel-preview-row-number${activeHeaderRow === absoluteRow ? " is-header-row" : ""}${isMatchedOrderRow ? " is-matched-row" : ""}${isActiveUnmatchedRow ? " is-unmatched-target" : ""}`}
                        tabIndex={0}
                        onClick={(event) => {
                          event.currentTarget.focus();
                          selectRow(absoluteRow);
                        }}
                        onBlur={() => setSelectedRow((row) => row === absoluteRow ? null : row)}
                        onDoubleClick={() => searchPricingForOrderRow(row, absoluteRow)}
                        title={activeSheet.name === mapping?.orderSheet && absoluteRow > mapping.orderHeaderRow ? "双击在核价 Sheet 中联合查询" : undefined}
                      >{absoluteRow}</span>
                      {orderedColumnIndexes.map((columnIndex) => {
                        const writebackColumnIndex = columnIndex - sourceColumnCount;
                        const totalCell = isWritebackTotalRow && isWritebackColumn(columnIndex)
                          ? writebackColumnIndex === 0
                            ? formatPreviewNumber(writebackTotals.pricingPrice)
                            : writebackColumnIndex === 1
                              ? formatPreviewNumber(writebackTotals.priceDifference)
                              : writebackColumnIndex === 2
                                ? String(writebackTotals.quantity)
                                : ""
                          : null;
                        const cell = totalCell ?? cellValue(row, columnIndex, absoluteRow);
                        const absoluteColumn = activeSheet.startColumn + columnIndex + 1;
                        const derived = isWritebackColumn(columnIndex);
                        const isDuplicateOrderCell = !derived
                          && !isHeaderRow
                          && absoluteColumn === mapping?.businessOrderNumberColumn
                          && isAdjacentDuplicate(activeSheet.rows, virtualRow.index, orderColumnIndex, firstDataRowIndex, (value) => value.trim());
                        const duplicateMappedClass = isDuplicateOrderCell
                          ? mappedColumnClass(mapping, activeSheet.name, absoluteColumn, singleShipmentMatchingEnabled)
                          : "";
                        const priceDifference = derived && writebackColumnIndex === 1
                          ? writebackBySourceRow.get(absoluteRow)?.priceDifference
                          : null;
                        const differenceClass = !isHeaderRow && typeof priceDifference === "number"
                          ? priceDifference > 0
                            ? " is-positive-difference"
                            : priceDifference < 0
                              ? " is-negative-difference"
                              : ""
                          : "";
                        const isWritebackQuantityColumn = derived && writebackColumnIndex === 2;
                        const sourceQuantity = isWritebackQuantityColumn && highestPrioritySkuQtyPair
                          ? parsePreviewQuantity(row[highestPrioritySkuQtyPair.mergedQtyColumn - activeSheet.startColumn - 1] ?? "")
                          : null;
                        const writebackQuantity = writebackBySourceRow.get(absoluteRow)?.quantity;
                        const writebackQuantityError = isWritebackQuantityColumn
                          ? writebackBySourceRow.get(absoluteRow)?.quantityError
                          : null;
                        const quantityMismatchClass = isWritebackQuantityColumn
                          && sourceQuantity !== null
                          && typeof writebackQuantity === "number"
                          && sourceQuantity !== writebackQuantity
                          ? " is-mismatched-quantity"
                          : "";
                        const writebackValueClass = derived && cell.trim() !== ""
                          ? " has-writeback-value"
                          : "";
                        const editableWritebackCell = derived && !isHeaderRow && !isWritebackTotalRow && writebackBySourceRow.has(absoluteRow);
                        const mappedClass = derived ? "" : mappedColumnClass(mapping, activeSheet.name, absoluteColumn, singleShipmentMatchingEnabled);
                        const isEditing = editingWritebackCell?.sourceRow === absoluteRow
                          && editingWritebackCell.columnIndex === writebackColumnIndex;
                        const isEditingCell = isEditing;
                        const isSelectedCell = !isEditingCell
                          && selectedCell?.sheetName === activeSheet.name
                          && selectedCell.row === absoluteRow
                          && selectedCell.column === absoluteColumn;
                        const headerCellDisplay = isHeaderRow && !derived && !cell.trim() ? "空表头" : cell;
                        return <span
                          className={`${derived ? "is-writeback-column" : isHeaderRow ? mappedClass : duplicateMappedClass}${editableWritebackCell ? " is-editable-writeback" : ""}${isEditingCell ? " is-editing-cell" : ""}${isSelectedCell ? " is-selected-cell" : ""}${writebackValueClass}${differenceClass}${quantityMismatchClass}${isDuplicateOrderCell ? " is-duplicate-order" : ""}${activeColumn === absoluteColumn ? " is-active-column" : ""}${isHeaderRow ? " is-header-cell" : ""}${isHeaderRow && !derived && !cell.trim() ? " is-empty-header" : ""}${hoveredColumn === absoluteColumn ? " is-hover-column" : ""}${selectingColumn && !derived ? " is-selectable-column" : ""}${pinnedColumnIndexes.includes(columnIndex) ? " is-pinned-column" : ""}${activeSearchMatch?.rowIndex === virtualRow.index && activeSearchMatch.columnIndex === columnIndex ? " is-search-match" : ""}`}
                          style={{ ...pinnedColumnStyle(columnIndex), ...(!derived && isHeaderRow ? skuPairStyle(mapping, activeSheet.name, absoluteColumn) : undefined) }}
                          title={isEditingCell
                            ? undefined
                            : writebackQuantityError ?? (isHeaderRow && !derived ? headerCellDisplay : cell)}
                          onMouseEnter={() => selectingColumn && !derived && setHoveredColumn(absoluteColumn)}
                          onPointerDown={(event) => {
                            if (editableWritebackCell) {
                              // 阻止双击时浏览器先选中单元格文字
                              if (event.detail > 1) event.preventDefault();
                              setSelectedCell({ sheetName: activeSheet.name, row: absoluteRow, column: absoluteColumn });
                            }
                          }}
                          onClick={() => {
                            if (selectingColumn && !derived) {
                              onColumnSelect?.(absoluteColumn, selectionHeaderRow ? activeSheet.rows[selectionHeaderRow - activeSheet.startRow - 1]?.[columnIndex] ?? "" : "");
                            }
                          }}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            window.getSelection()?.removeAllRanges();
                            if (editableWritebackCell) {
                              setSelectedCell({ sheetName: activeSheet.name, row: absoluteRow, column: absoluteColumn });
                              setEditingWritebackCell({ sourceRow: absoluteRow, columnIndex: writebackColumnIndex, value: cell });
                            }
                          }}
                          key={columnIndex}
                        >{isEditing ? <input
                            ref={focusEditor}
                            aria-label={`编辑第 ${absoluteRow} 行${writebackColumnHeaders[writebackColumnIndex]}`}
                            inputMode="decimal"
                            spellCheck={false}
                            value={editingWritebackCell.value}
                            onChange={(event) => setEditingWritebackCell({ ...editingWritebackCell, value: event.currentTarget.value })}
                            onBlur={commitWritebackEdit}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitWritebackEdit();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                setEditingWritebackCell(null);
                              }
                            }}
                          /> : headerCellDisplay}</span>;
                      })}
                    </div>
                  );
                })}
              </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {activeSheet ? (
        <footer className="excel-preview-legend" aria-label="字段颜色说明">
          <div className="excel-preview-legend-colors">
            {mapping && activeSheet.name === mapping.orderSheet
              ? skuQtyPairsByPriority(mapping).map((pair, index) => <span key={`${pair.skuColumn}-${pair.mergedQtyColumn}`}><i className="is-sku-qty" style={{ "--sku-pair-strength": `${skuPairShadeStrengths[Math.min(index, skuPairShadeStrengths.length - 1)]}%` } as SkuPairStyle} />SKU/数量 {index + 1}</span>)
              : <span><i className="is-sku" />SKU 字段</span>}
            <span><i className="is-price" />价格字段</span>
            <span><i className="is-mapped" />常规匹配字段</span>
            {showsWritebackColumns ? <span><i className="is-writeback" />写回结果</span> : null}
            {showsWritebackColumns ? <span><i className="is-alert" />金额差/数量异常</span> : null}
            {mapping && activeSheet.name === mapping.orderSheet ? <span><i className="is-matched-row" />已匹配行号</span> : null}
            {mapping && activeSheet.name === mapping.orderSheet && unmatchedOrderRows.length > 0 ? <span><i className="is-unmatched-row" />未匹配定位行</span> : null}
          </div>
          <div className="excel-preview-legend-hints" aria-label="操作提示">
            <span>双击写回格可改</span>
            <span>图钉冻结列</span>
            <span>拖动表头调列宽</span>
            <span>Ctrl+F 搜索</span>
            {mapping && activeSheet.name === mapping.orderSheet ? <span>未匹配定位 ↑↓ Enter 详情</span> : null}
            <span>点列头/单元格映射字段</span>
            <div className="excel-preview-scroll-actions" aria-label="详情表格快速滚动">
              <button
                type="button"
                aria-label="滚动详情表格到表头"
                title="滚动到表头"
                onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
              >
                <ArrowUp />
              </button>
              <button
                type="button"
                aria-label="滚动详情表格到表尾"
                title="滚动到表尾"
                onClick={() => {
                  const scrollContainer = scrollRef.current;
                  scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
                }}
              >
                <ArrowDown />
              </button>
            </div>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

export type { ExcelPreviewCandidate };
