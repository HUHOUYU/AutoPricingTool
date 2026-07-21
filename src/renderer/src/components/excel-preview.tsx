import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, FileSpreadsheet, LoaderCircle, Pin, PinOff, Table2 } from "lucide-react";
import type { DesktopAPI, PriceCheckMapping } from "../../../preload";
import type { MappingFieldTarget } from "./mapping-editor";
import type {
  ExcelPreviewCandidate,
  ExcelPreviewSheet,
  ExcelPreviewWorkbook,
  ExcelPreviewWorkerRequest,
  ExcelPreviewWorkerResponse,
} from "../lib/excel-preview";

type ExcelPreviewProps = {
  api: DesktopAPI | null;
  filePath: string;
  candidates: ExcelPreviewCandidate[];
  activeSheetName: string;
  onActiveSheetChange: (sheetName: string) => void;
  mapping?: PriceCheckMapping | null;
  matchedOrderRows?: number[];
  activeTarget?: MappingFieldTarget | null;
  selectionPrompt?: string;
  onWorkbookChange?: (workbook: ExcelPreviewWorkbook | null) => void;
  onColumnSelect?: (column: number, headerText: string) => void;
  onRowSelect?: (row: number) => void;
};

type PreviewStatus = "empty" | "loading" | "ready" | "error";

const previewRowHeight = 30;
const previewRowNumberWidth = 52;
const previewColumnWidth = 120;
const previewColumnMinWidth = 64;
const previewColumnMaxWidth = 480;

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

function mappedColumnClass(mapping: PriceCheckMapping | null | undefined, sheetName: string, column: number): string {
  if (!mapping) return "";
  if (sheetName === mapping.orderSheet) {
    if (mapping.skuQtyPairs.some((pair) => pair.skuColumn === column)) return " is-sku-column";
    if (mapping.orderPriceColumn === column) return " is-price-column";
    if (mapping.skuQtyPairs.some((pair) => pair.qtyColumn === column) || [mapping.businessOrderNumberColumn, mapping.platformOrderNumberColumn, mapping.countryCodeColumn, mapping.countryEnglishColumn, mapping.countryChineseColumn, mapping.shippingMethodColumn].includes(column)) return " is-mapped-column";
  }
  if (sheetName === mapping.pricingSheet) {
    if (mapping.pricingSkuColumn === column) return " is-sku-column";
    if (mapping.quantityTierColumns.some((tier) => tier.column === column)) return " is-price-column";
    if ([mapping.pricingCountryColumn, mapping.pricingShippingMethodColumn].includes(column)) return " is-mapped-column";
  }
  return "";
}

function targetColumn(mapping: PriceCheckMapping | null | undefined, target: MappingFieldTarget | null | undefined): number | null {
  if (!mapping || !target || target.endsWith("HeaderRow")) return null;
  const pairMatch = /^skuQtyPairs\.(\d+)\.(skuColumn|qtyColumn)$/.exec(target);
  if (pairMatch) return mapping.skuQtyPairs[Number(pairMatch[1])]?.[pairMatch[2] as "skuColumn" | "qtyColumn"] ?? null;
  const tierMatch = /^quantityTierColumns\.(\d+)\.column$/.exec(target);
  if (tierMatch) return mapping.quantityTierColumns[Number(tierMatch[1])]?.column ?? null;
  return (mapping[target as keyof PriceCheckMapping] as number | null | undefined) ?? null;
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

export function ExcelPreview({ api, filePath, candidates, activeSheetName, onActiveSheetChange, mapping, matchedOrderRows, activeTarget, selectionPrompt, onWorkbookChange, onColumnSelect, onRowSelect }: ExcelPreviewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const [status, setStatus] = useState<PreviewStatus>(candidates.length > 0 ? "loading" : "empty");
  const [workbook, setWorkbook] = useState<ExcelPreviewWorkbook | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [columnWidthsBySheet, setColumnWidthsBySheet] = useState<Record<string, number[]>>({});
  const [pinnedColumnsBySheet, setPinnedColumnsBySheet] = useState<Record<string, number[]>>({});
  const [resizingColumn, setResizingColumn] = useState<number | null>(null);

  useEffect(() => {
    setColumnWidthsBySheet({});
    setPinnedColumnsBySheet({});
    setResizingColumn(null);
  }, [filePath]);

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
      const request: ExcelPreviewWorkerRequest = { requestId, buffer, candidates };
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
  }, [api, candidates, filePath]);

  useEffect(() => {
    onWorkbookChange?.(workbook);
  }, [onWorkbookChange, workbook]);

  const activeSheet = useMemo<ExcelPreviewSheet | null>(() => (
    workbook?.sheets.find((sheet) => sheet.name === activeSheetName) ?? null
  ), [activeSheetName, workbook]);
  const shouldVirtualizeRows = (activeSheet?.rows.length ?? 0) > 100;
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualizeRows ? activeSheet?.rows.length ?? 0 : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => previewRowHeight,
    overscan: 10,
  });

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
    scrollRef.current.scrollLeft = 0;
    rowVirtualizer.measure();
  }, [activeSheetName, rowVirtualizer]);

  const columnCount = activeSheet?.displayedColumnCount ?? 0;
  const columnWidths = Array.from({ length: columnCount }, (_, index) => columnWidthsBySheet[activeSheetName]?.[index] ?? previewColumnWidth);
  const pinnedColumnIndexes = (pinnedColumnsBySheet[activeSheetName] ?? []).filter((columnIndex) => columnIndex < columnCount);
  const orderedColumnIndexes = [...pinnedColumnIndexes, ...Array.from({ length: columnCount }, (_, index) => index).filter((columnIndex) => !pinnedColumnIndexes.includes(columnIndex))];
  const gridWidth = previewRowNumberWidth + columnWidths.reduce((total, width) => total + width, 0);
  const renderedRows = shouldVirtualizeRows
    ? rowVirtualizer.getVirtualItems()
    : (activeSheet?.rows ?? []).map((_, index) => ({ index, key: index, size: previewRowHeight, start: index * previewRowHeight }));
  const rowsHeight = shouldVirtualizeRows ? rowVirtualizer.getTotalSize() : (activeSheet?.rows.length ?? 0) * previewRowHeight;
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
  const matchedOrderRowSet = useMemo(() => new Set(matchedOrderRows ?? []), [matchedOrderRows]);

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

  return (
    <section className={`excel-preview-panel${activeTarget ? " is-selecting" : ""}`} aria-label="Excel 预览">
      <header>
        <div><span><FileSpreadsheet /></span><div><strong>Excel 预览</strong><small>只读数据表 · 不执行公式或宏</small></div></div>
        {fileSize !== null ? <em>{formatBytes(fileSize)}</em> : null}
      </header>
      <div className="excel-preview-tabs" role="tablist" aria-label="候选 Sheet">
        {candidates.map((candidate) => (
          <button
            type="button"
            role="tab"
            aria-selected={candidate.name === activeSheetName}
            className={candidate.name === activeSheetName ? "is-active" : ""}
            onClick={() => onActiveSheetChange(candidate.name)}
            key={candidate.name}
          >
            <strong>{candidate.name}</strong><span>{roleLabel(candidate)}</span>
          </button>
        ))}
      </div>
      {activeTarget ? <div className="excel-preview-selection-prompt" role="status"><strong>{selectionPrompt}</strong><span>{activeTarget.endsWith("HeaderRow") ? "点击左侧行号" : "点击目标列中的任意单元格"}</span><kbd>Esc 取消</kbd></div> : null}
      <div className="excel-preview-body">
        {status === "empty" ? <PreviewState icon={<Table2 />} title="暂无候选 Sheet" detail="完成文件分析后将在此显示订单与核价候选表" /> : null}
        {status === "loading" ? <PreviewState icon={<LoaderCircle />} title="正在读取工作簿" detail="仅解析候选 Sheet 与前 500 行" loading /> : null}
        {status === "error" ? <PreviewState icon={<AlertTriangle />} title="无法预览工作簿" detail={errorMessage} /> : null}
        {status === "ready" && !activeSheet ? <PreviewState icon={<AlertTriangle />} title="候选 Sheet 不存在" detail="工作簿中未找到该候选表，请重新分析文件" /> : null}
        {status === "ready" && activeSheet && columnCount === 0 ? <PreviewState icon={<Table2 />} title="Sheet 内容为空" detail="该候选表没有可显示的单元格" /> : null}
        {status === "ready" && activeSheet && columnCount > 0 ? (
          <div className="excel-preview-scroll" ref={scrollRef}>
            <div className="excel-preview-grid" style={{ width: `${gridWidth}px` }} onMouseLeave={() => setHoveredColumn(null)}>
              <div className="excel-preview-header" style={gridStyle}>
                <span className="excel-preview-corner">#</span>
                {orderedColumnIndexes.map((columnIndex) => (
                  <span
                    className={`${mappedColumnClass(mapping, activeSheet.name, activeSheet.startColumn + columnIndex + 1)}${activeColumn === activeSheet.startColumn + columnIndex + 1 ? " is-active-column" : ""}${hoveredColumn === activeSheet.startColumn + columnIndex + 1 ? " is-hover-column" : ""}${selectingColumn ? " is-selectable-column" : ""}${pinnedColumnIndexes.includes(columnIndex) ? " is-pinned-column" : ""}`}
                    style={pinnedColumnStyle(columnIndex)}
                    data-column-label={excelColumnLabel(activeSheet.startColumn + columnIndex)}
                    onMouseEnter={() => selectingColumn && setHoveredColumn(activeSheet.startColumn + columnIndex + 1)}
                    onClick={() => selectingColumn && onColumnSelect?.(activeSheet.startColumn + columnIndex + 1, selectionHeaderRow ? activeSheet.rows[selectionHeaderRow - activeSheet.startRow - 1]?.[columnIndex] ?? "" : "")}
                    key={columnIndex}
                  >
                    {excelColumnLabel(activeSheet.startColumn + columnIndex)}
                    <button
                      type="button"
                      className="excel-preview-column-pin"
                      aria-label={`${pinnedColumnIndexes.includes(columnIndex) ? "取消冻结" : "冻结"} ${excelColumnLabel(activeSheet.startColumn + columnIndex)} 列`}
                      title={pinnedColumnIndexes.includes(columnIndex) ? "取消冻结列" : "冻结到左侧"}
                      onClick={(pinEvent) => { pinEvent.stopPropagation(); togglePinnedColumn(columnIndex); }}
                    >{pinnedColumnIndexes.includes(columnIndex) ? <PinOff /> : <Pin />}</button>
                    <span
                      className={`excel-preview-column-resizer${resizingColumn === columnIndex ? " is-resizing" : ""}`}
                      role="separator"
                      tabIndex={0}
                      aria-label={`调整 ${excelColumnLabel(activeSheet.startColumn + columnIndex)} 列宽`}
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
                ))}
              </div>
              {frozenHeaderRow ? <div className="excel-preview-row excel-preview-frozen-header" style={gridStyle} aria-label={`冻结表头，第 ${activeHeaderRow} 行`}>
                <span className="excel-preview-row-number is-header-row" onClick={() => onRowSelect?.(activeHeaderRow ?? 1)}>{activeHeaderRow}</span>
                {orderedColumnIndexes.map((columnIndex) => {
                  const cell = frozenHeaderRow[columnIndex] ?? "";
                  const absoluteColumn = activeSheet.startColumn + columnIndex + 1;
                  return <span
                    className={`${mappedColumnClass(mapping, activeSheet.name, absoluteColumn)}${activeColumn === absoluteColumn ? " is-active-column" : ""} is-header-cell${hoveredColumn === absoluteColumn ? " is-hover-column" : ""}${selectingColumn ? " is-selectable-column" : ""}${pinnedColumnIndexes.includes(columnIndex) ? " is-pinned-column" : ""}`}
                    style={pinnedColumnStyle(columnIndex)}
                    title={cell}
                    onMouseEnter={() => selectingColumn && setHoveredColumn(absoluteColumn)}
                    onClick={() => selectingColumn && onColumnSelect?.(absoluteColumn, cell)}
                    key={columnIndex}
                  >{cell}</span>;
                })}
              </div> : null}
              <div className="excel-preview-rows" style={{ height: `${rowsHeight}px`, width: `${gridWidth}px` }}>
                {renderedRows.map((virtualRow) => {
                  const row = activeSheet.rows[virtualRow.index] ?? [];
                  const absoluteRow = activeSheet.startRow + virtualRow.index + 1;
                  const isMatchedOrderRow = activeSheet.name === mapping?.orderSheet && matchedOrderRowSet.has(absoluteRow);
                  return (
                    <div
                      className="excel-preview-row"
                      style={{ ...gridStyle, height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                      key={virtualRow.key}
                    >
                      <span
                        className={`excel-preview-row-number${activeHeaderRow === absoluteRow ? " is-header-row" : ""}${isMatchedOrderRow ? " is-matched-row" : ""}`}
                        onClick={() => onRowSelect?.(absoluteRow)}
                      >{absoluteRow}</span>
                      {orderedColumnIndexes.map((columnIndex) => {
                        const cell = row[columnIndex] ?? "";
                        const absoluteColumn = activeSheet.startColumn + columnIndex + 1;
                        return <span
                          className={`${mappedColumnClass(mapping, activeSheet.name, absoluteColumn)}${activeColumn === absoluteColumn ? " is-active-column" : ""}${activeHeaderRow === absoluteRow ? " is-header-cell" : ""}${hoveredColumn === absoluteColumn ? " is-hover-column" : ""}${selectingColumn ? " is-selectable-column" : ""}${pinnedColumnIndexes.includes(columnIndex) ? " is-pinned-column" : ""}`}
                          style={pinnedColumnStyle(columnIndex)}
                          title={cell}
                          onMouseEnter={() => selectingColumn && setHoveredColumn(absoluteColumn)}
                          onClick={() => selectingColumn && onColumnSelect?.(absoluteColumn, selectionHeaderRow ? activeSheet.rows[selectionHeaderRow - activeSheet.startRow - 1]?.[columnIndex] ?? "" : "")}
                          key={columnIndex}
                        >{cell}</span>;
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {activeSheet ? (
        <footer className="excel-preview-legend" aria-label="字段颜色说明">
          <span><i className="is-sku" />SKU 字段</span>
          <span><i className="is-price" />价格字段</span>
          <span><i className="is-mapped" />常规匹配字段</span>
        </footer>
      ) : null}
    </section>
  );
}

export type { ExcelPreviewCandidate };
