import type { CSSProperties } from "react";
import { ArrowUpDown, FileSpreadsheet, Inbox, Pin, PinOff, Settings2, X } from "lucide-react";
import type { PriceAnalysisFile, PriceCheckMapping } from "@shared/desktop-api";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import type { FileTab } from "@/stores/ui-store";
import { fileNameFromPath, formatCoverage } from "../file-utils";
import { statusMeta, type FileResult, type FileStatus, type ImportMode } from "../types";
import type { FileTableModel } from "../hooks/use-file-table-model";

export type FileTableEmptyState = {
  title: string;
  detail: string;
  action?: {
    label: string;
    onClick: () => void;
  } | null;
};

type FileTableColumnManagerProps = {
  model: FileTableModel;
};

export function FileTableColumnManager({ model }: FileTableColumnManagerProps): React.JSX.Element {
  return (
    <details className="cyber-column-manager">
      <summary aria-label="列管理"><Settings2 /></summary>
      <div>
        {model.table.getAllLeafColumns().filter((column) => column.getCanHide()).map((column) => (
          <label key={column.id}>
            <Checkbox
              checked={column.getIsVisible()}
              onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))}
            />
            {String(column.columnDef.header)}
          </label>
        ))}
      </div>
    </details>
  );
}

type WorkbenchFileTableProps = {
  model: FileTableModel;
  activeTab: FileTab;
  analyses: Record<string, PriceAnalysisFile>;
  mappings: Record<string, PriceCheckMapping>;
  results: Record<string, FileResult>;
  importModes: Record<string, ImportMode>;
  importedAt: Record<string, string>;
  fileStatusByPath: Record<string, FileStatus>;
  selectedPaths: ReadonlySet<string>;
  selectedAll: boolean;
  highlightedPath: string | null;
  busy: boolean;
  emptyState: FileTableEmptyState;
  onToggleSelected: (path: string) => void;
  onToggleAllSelected: () => void;
  onOpenSource: (path: string) => void;
  onOpenDetail: (path: string) => void;
  onOpenOutput: (path: string) => void;
  onRemove: (path: string) => void;
};

export function WorkbenchFileTable({
  model,
  activeTab,
  analyses,
  mappings,
  results,
  importModes,
  importedAt,
  fileStatusByPath,
  selectedPaths,
  selectedAll,
  highlightedPath,
  busy,
  emptyState,
  onToggleSelected,
  onToggleAllSelected,
  onOpenSource,
  onOpenDetail,
  onOpenOutput,
  onRemove,
}: WorkbenchFileTableProps): React.JSX.Element {
  return (
    <div className={`cyber-table-scroll${model.hasRows ? "" : " is-empty"}`} ref={model.tableScrollRef}>
      <table
        className={`cyber-file-table is-${activeTab}`}
        style={{ "--cyber-table-width": `${model.table.getTotalSize()}px` } as CSSProperties}
      >
        <colgroup>
          {model.visibleColumns.map((column) => (
            <col
              key={column.id}
              className={column.id === "select" ? "checkbox-column" : column.id === "index" ? "index-column" : column.id === "actions" ? "action-column" : undefined}
              style={{ width: `${column.getSize()}px` }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {model.visibleHeaders.map((header) => {
              const column = header.column;
              const className = `${column.id === "select" ? "checkbox-column" : column.id === "index" ? "index-column" : column.id === "actions" ? "action-column" : ""}${column.getIsPinned() ? " is-pinned-column" : ""}`.trim() || undefined;
              return (
                <th key={header.id} className={className} style={model.pinnedStyle(column, true)}>
                  {column.id === "select" ? (
                    <Checkbox
                      checked={selectedAll}
                      onCheckedChange={onToggleAllSelected}
                      aria-label="全选当前状态文件"
                    />
                  ) : (
                    <button type="button" disabled={!column.getCanSort()} onClick={column.getToggleSortingHandler()}>
                      {String(column.columnDef.header)}
                      {column.getCanSort() ? <ArrowUpDown /> : null}
                    </button>
                  )}
                  {column.getCanPin() ? (
                    <button
                      type="button"
                      className="table-column-pin"
                      aria-label={`${column.getIsPinned() ? "取消冻结" : "冻结"} ${String(column.columnDef.header)} 列`}
                      title={column.getIsPinned() ? "取消冻结列" : "冻结到左侧"}
                      onClick={() => model.toggleColumnPin(column.id)}
                    >
                      {column.getIsPinned() ? <PinOff /> : <Pin />}
                    </button>
                  ) : null}
                  {model.hasRows && column.getCanResize() ? (
                    <div
                      className={`column-resizer${column.getIsResizing() ? " is-resizing" : ""}`}
                      role="separator"
                      tabIndex={0}
                      title="拖动调整列宽，双击恢复默认"
                      aria-label={`调整 ${String(column.columnDef.header)} 列宽`}
                      aria-orientation="vertical"
                      aria-valuemin={column.columnDef.minSize ?? 80}
                      aria-valuemax={column.columnDef.maxSize ?? 560}
                      aria-valuenow={header.getSize()}
                      onDoubleClick={() => column.resetSize()}
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onKeyDown={(event) => {
                        const delta = event.key === "ArrowLeft" ? -8 : event.key === "ArrowRight" ? 8 : 0;
                        if (!delta) return;
                        event.preventDefault();
                        model.resizeColumn(column.id, header.getSize(), delta);
                      }}
                    />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody style={model.shouldVirtualizeRows ? { height: model.rowVirtualizer.getTotalSize(), position: "relative" } : undefined}>
          {model.renderedRows.map(({ row, virtualRow }) => {
            const path = row.original;
            const analysis = analyses[path];
            const result = results[path];
            const currentMapping = mappings[path] ?? analysis?.suggestedMapping ?? null;
            const status = fileStatusByPath[path];
            return (
              <tr
                key={path}
                ref={virtualRow ? model.rowVirtualizer.measureElement : undefined}
                data-index={virtualRow?.index}
                data-file-path={path}
                className={`${selectedPaths.has(path) ? "is-selected" : ""}${highlightedPath === path ? " is-result-revealed" : ""}`.trim()}
                style={virtualRow ? { position: "absolute", transform: `translateY(${virtualRow.start}px)`, width: "100%", display: "table", tableLayout: "fixed" } : undefined}
              >
                {[...row.getLeftVisibleCells(), ...row.getCenterVisibleCells(), ...row.getRightVisibleCells()].map((cell) => {
                  const pinnedClass = cell.column.getIsPinned() ? " is-pinned-column" : "";
                  const pinnedStyle = model.pinnedStyle(cell.column);
                  if (cell.column.id === "select") {
                    return <td key={cell.id} className={`checkbox-column${pinnedClass}`} style={pinnedStyle}><Checkbox checked={selectedPaths.has(path)} onCheckedChange={() => onToggleSelected(path)} aria-label={"选择 " + fileNameFromPath(path)} /></td>;
                  }
                  if (cell.column.id === "index") {
                    return <td key={cell.id} className={`index-column${pinnedClass}`} style={pinnedStyle}>{model.files.indexOf(path) + 1}</td>;
                  }
                  if (cell.column.id === "fileName") {
                    return <td key={cell.id} className={`file-cell${pinnedClass}`} style={pinnedStyle}><FileSpreadsheet /><button type="button" onClick={() => onOpenSource(path)} title={path}>{fileNameFromPath(path)}</button></td>;
                  }
                  if (cell.column.id === "orderSheet") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{currentMapping?.orderSheet ?? "—"}</td>;
                  }
                  if (cell.column.id === "pricingSheet") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{currentMapping?.pricingSheet ?? "—"}</td>;
                  }
                  if (cell.column.id === "coverage") {
                    const value = result?.coverage ?? analysis?.coverage;
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{value === undefined ? "—" : <div className="coverage-cell"><Progress value={value * 100} /><span>{formatCoverage(value)}</span></div>}</td>;
                  }
                  if (cell.column.id === "importMode") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{importModes[path] === "folder" ? "文件夹" : importModes[path] === "config" ? "配置目录" : "文件"}</td>;
                  }
                  if (cell.column.id === "status") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}><span className={"cyber-status is-" + statusMeta[status].tone}><i />{statusMeta[status].label}</span>{result?.status === "completed" ? <small>{result.matchedRows ?? 0}/{result.totalRows ?? 0} 行</small> : null}</td>;
                  }
                  if (cell.column.id === "createdAt") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{importedAt[path] ?? "—"}</td>;
                  }
                  if (cell.column.id === "evidence") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{analysis?.automationDecision.evaluatedRows ?? 0} 行</td>;
                  }
                  if (cell.column.id === "issue") {
                    const issue = result?.status === "completed" && (result.exceptionRows ?? 0) > 0
                      ? `${result.exceptionRows} 行存在异常`
                      : result?.message ?? analysis?.automationDecision.reasons[0] ?? analysis?.issues[0] ?? "—";
                    return <td key={cell.id} className={`issue-cell${pinnedClass}`} style={pinnedStyle} title={issue}>{issue}</td>;
                  }
                  if (cell.column.id === "rows") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{result ? `${result.matchedRows ?? 0}/${result.totalRows ?? 0}` : "—"}</td>;
                  }
                  if (cell.column.id === "completedAt") {
                    return <td key={cell.id} className={pinnedClass.trim() || undefined} style={pinnedStyle}>{result?.completedAt ?? importedAt[path] ?? "—"}</td>;
                  }
                  return (
                    <td key={cell.id} className={`action-column${pinnedClass}`} style={pinnedStyle}>
                      <button type="button" onClick={() => onOpenDetail(path)}>详情</button>
                      {activeTab === "success" && result?.outputPath ? <button type="button" onClick={() => onOpenOutput(result.outputPath ?? "")}>打开</button> : null}
                      {activeTab === "pending" ? <button type="button" disabled={busy} onClick={() => onRemove(path)} aria-label={"移除 " + fileNameFromPath(path)}><X /></button> : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!model.hasRows ? (
        <div className="cyber-empty cyber-empty-overlay">
          <div className="cyber-empty-visual" aria-hidden="true"><Inbox /></div>
          <strong>{emptyState.title}</strong>
          <span>{emptyState.detail}</span>
          {emptyState.action ? (
            <button type="button" className="cyber-empty-action" onClick={emptyState.action.onClick}>
              {emptyState.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
