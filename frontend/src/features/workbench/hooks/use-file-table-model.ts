import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnPinningState,
  type ColumnSizingState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PriceAnalysisFile, PriceCheckMapping } from "@shared/desktop-api";
import type { FileTab } from "@/stores/ui-store";
import { fileNameFromPath } from "../file-utils";
import type { FileResult, FileStatus, ImportMode } from "../types";

type UseFileTableModelOptions = {
  files: string[];
  pagedFiles: string[];
  activeTab: FileTab;
  analyses: Record<string, PriceAnalysisFile>;
  mappings: Record<string, PriceCheckMapping>;
  results: Record<string, FileResult>;
  importModes: Record<string, ImportMode>;
  importedAt: Record<string, string>;
  fileStatusByPath: Record<string, FileStatus>;
  expandedPath: string | null;
};

const initialPinnedColumns: Record<FileTab, string[]> = {
  pending: [],
  queued: [],
  confirm: [],
  error: [],
  success: [],
};

export function useFileTableModel({
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
}: UseFileTableModelOptions) {
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [pinnedColumns, setPinnedColumns] = useState<Record<FileTab, string[]>>(initialPinnedColumns);

  const columns = useMemo<ColumnDef<string>[]>(() => {
    const selectColumn: ColumnDef<string> = { id: "select", header: "", size: 38, minSize: 38, maxSize: 38, enableSorting: false, enableHiding: false, enablePinning: false, enableResizing: false };
    const indexColumn: ColumnDef<string> = { id: "index", header: "序号", size: 64, enableSorting: false, enableHiding: false, enablePinning: false, enableResizing: false };
    const fileColumn: ColumnDef<string> = { id: "fileName", header: "原始文件名", size: 240, minSize: 180, maxSize: 360, accessorFn: fileNameFromPath };
    const actionColumn: ColumnDef<string> = { id: "actions", header: "操作", size: activeTab === "pending" ? 104 : 80, minSize: 64, maxSize: 180, enableSorting: false, enableHiding: false, enablePinning: false, enableResizing: false };
    const orderColumn: ColumnDef<string> = { id: "orderSheet", header: "订单 Sheet", size: 170, accessorFn: (path) => (mappings[path] ?? analyses[path]?.suggestedMapping)?.orderSheet ?? "" };
    const pricingColumn: ColumnDef<string> = { id: "pricingSheet", header: "核价 Sheet", size: 190, accessorFn: (path) => (mappings[path] ?? analyses[path]?.suggestedMapping)?.pricingSheet ?? "" };
    const coverageColumn: ColumnDef<string> = { id: "coverage", header: "匹配率", size: 230, minSize: 140, accessorFn: (path) => results[path]?.coverage ?? analyses[path]?.coverage ?? -1 };
    if (activeTab === "pending") {
      return [
        selectColumn,
        indexColumn,
        fileColumn,
        { id: "importMode", header: "导入方式", size: 220, accessorFn: (path) => importModes[path] ?? "file" },
        { id: "status", header: "处理阶段", size: 240, accessorFn: (path) => fileStatusByPath[path] },
        { id: "createdAt", header: "导入时间", size: 300, accessorFn: (path) => importedAt[path] ?? "" },
        actionColumn,
      ];
    }
    if (activeTab === "queued") {
      return [
        selectColumn,
        indexColumn,
        fileColumn,
        orderColumn,
        pricingColumn,
        coverageColumn,
        { id: "status", header: "处理阶段", size: 140, accessorFn: (path) => fileStatusByPath[path] },
        actionColumn,
      ];
    }
    if (activeTab === "confirm") {
      return [
        selectColumn,
        indexColumn,
        fileColumn,
        orderColumn,
        pricingColumn,
        coverageColumn,
        { id: "evidence", header: "试算行数", size: 140, accessorFn: (path) => analyses[path]?.automationDecision.evaluatedRows ?? 0 },
        { id: "issue", header: "待确认原因", size: 340, minSize: 180, accessorFn: (path) => analyses[path]?.automationDecision.reasons.join("；") ?? "" },
        actionColumn,
      ];
    }
    if (activeTab === "error") {
      return [
        selectColumn,
        indexColumn,
        fileColumn,
        { id: "issue", header: "问题摘要", accessorFn: (path) => results[path]?.message ?? analyses[path]?.automationDecision.reasons.join("；") ?? "" },
        { id: "rows", header: "匹配行数", accessorFn: (path) => results[path]?.matchedRows ?? 0 },
        coverageColumn,
        { id: "completedAt", header: "更新时间", accessorFn: (path) => results[path]?.completedAt ?? importedAt[path] ?? "" },
        actionColumn,
      ];
    }
    return [
      selectColumn,
      indexColumn,
      fileColumn,
      orderColumn,
      pricingColumn,
      { id: "rows", header: "匹配行数", accessorFn: (path) => results[path]?.matchedRows ?? 0 },
      coverageColumn,
      { id: "completedAt", header: "完成时间", accessorFn: (path) => results[path]?.completedAt ?? "" },
      actionColumn,
    ];
  }, [activeTab, analyses, fileStatusByPath, importModes, importedAt, mappings, results]);

  const table = useReactTable({
    data: pagedFiles,
    columns,
    defaultColumn: { size: 180, minSize: 80, maxSize: 560 },
    state: {
      sorting,
      columnVisibility,
      columnSizing,
      columnPinning: { left: pinnedColumns[activeTab], right: [] } satisfies ColumnPinningState,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const visibleColumns = [
    ...table.getLeftVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getRightVisibleLeafColumns(),
  ];
  const headersByColumn = new Map(table.getHeaderGroups()[0].headers.map((header) => [header.column.id, header]));
  const visibleHeaders = visibleColumns
    .map((column) => headersByColumn.get(column.id))
    .filter((header) => header !== undefined);

  const rows = table.getRowModel().rows;
  const shouldVirtualizeRows = rows.length > 100 && expandedPath === null;
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualizeRows ? rows.length : 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 39,
    overscan: 12,
  });
  const renderedRows = shouldVirtualizeRows
    ? rowVirtualizer.getVirtualItems().map((virtualRow) => ({ row: rows[virtualRow.index], virtualRow }))
    : rows.map((row) => ({ row, virtualRow: null }));

  const toggleColumnPin = (columnId: string): void => {
    setPinnedColumns((current) => {
      const pinned = current[activeTab];
      return {
        ...current,
        [activeTab]: pinned.includes(columnId)
          ? pinned.filter((id) => id !== columnId)
          : [...pinned, columnId],
      };
    });
  };

  const pinnedStyle = (column: Column<string, unknown>, header = false): CSSProperties =>
    column.getIsPinned() === "left"
      ? {
          left: `${column.getStart("left")}px`,
          position: "sticky",
          width: `${column.getSize()}px`,
          zIndex: header ? 7 : 4,
        }
      : { width: `${column.getSize()}px` };

  const resizeColumn = (columnId: string, currentSize: number, delta: number): void => {
    const column = table.getColumn(columnId);
    if (!column) return;
    const minSize = column.columnDef.minSize ?? 80;
    const maxSize = column.columnDef.maxSize ?? 560;
    setColumnSizing((current) => ({
      ...current,
      [columnId]: Math.min(maxSize, Math.max(minSize, currentSize + delta)),
    }));
  };

  return {
    table,
    tableScrollRef,
    visibleColumns,
    visibleHeaders,
    renderedRows,
    shouldVirtualizeRows,
    rowVirtualizer,
    hasRows: renderedRows.length > 0,
    toggleColumnPin,
    pinnedStyle,
    resizeColumn,
    files,
  };
}

export type FileTableModel = ReturnType<typeof useFileTableModel>;
