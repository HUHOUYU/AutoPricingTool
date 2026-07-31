import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FileTab } from "@/stores/ui-store";
import { FileTableColumnManager } from "./file-table";
import { fileNameFromPath } from "../file-utils";
import { fileTabs } from "../types";
import type { FileTableModel } from "../hooks/use-file-table-model";

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500, 1000] as const;

type BatchFileToolbarProps = {
  visibleFileCount: number;
  fileCount: number;
  batchId: string | null;
  batchName: string;
  defaultBatchName: string;
  editingBatchName: boolean;
  activeTab: FileTab;
  tabCounts: Record<FileTab, number>;
  tableModel: FileTableModel;
  onBatchNameChange: (name: string) => void;
  onCommitBatchName: () => void;
  onCancelBatchName: () => void;
  onBeginBatchNameEdit: () => void;
  onTabChange: (tab: FileTab) => void;
};

export function BatchFileToolbar({
  visibleFileCount,
  fileCount,
  batchId,
  batchName,
  defaultBatchName,
  editingBatchName,
  activeTab,
  tabCounts,
  tableModel,
  onBatchNameChange,
  onCommitBatchName,
  onCancelBatchName,
  onBeginBatchNameEdit,
  onTabChange,
}: BatchFileToolbarProps): React.JSX.Element {
  return (
    <header className="cyber-table-toolbar">
      <div className="cyber-file-list-title">
        <h2>文件列表 <span>（{visibleFileCount}）</span></h2>
        {fileCount > 0 ? (
          <div
            className="cyber-batch-name"
            title={batchId ? `批次 ID：${batchId}` : "开始核价后写入日志中心"}
          >
            <small>当前批次</small>
            {editingBatchName ? (
              <input
                autoFocus
                value={batchName}
                maxLength={120}
                aria-label="批次名称"
                onChange={(event) => onBatchNameChange(event.target.value)}
                onBlur={onCommitBatchName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") onCancelBatchName();
                }}
              />
            ) : (
              <button
                type="button"
                onClick={onBeginBatchNameEdit}
                aria-label="编辑批次名称"
              >
                <span data-name={batchName || defaultBatchName} />
                <Pencil />
              </button>
            )}
          </div>
        ) : null}
      </div>
      {fileCount > 0 ? (
        <div className="cyber-table-actions">
          <div className="cyber-tabs" aria-label="文件状态统计">
            {fileTabs.map((tab) => (
              <button
                type="button"
                className={activeTab === tab.key ? "is-active" : ""}
                key={tab.key}
                onClick={() => onTabChange(tab.key)}
              >
                {tab.label}<b>{tabCounts[tab.key]}</b>
              </button>
            ))}
          </div>
          <FileTableColumnManager model={tableModel} />
        </div>
      ) : null}
    </header>
  );
}

type BatchProgressPanelProps = {
  visible: boolean;
  taskActive: boolean;
  phaseLabel: string;
  percent: number;
  current: number;
  total: number;
  fileCount: number;
  activePath: string;
  actions: ReactNode;
};

export function BatchProgressPanel({
  visible,
  taskActive,
  phaseLabel,
  percent,
  current,
  total,
  fileCount,
  activePath,
  actions,
}: BatchProgressPanelProps): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          className={`cyber-batch-progress${taskActive ? " is-running" : " is-settled"}`}
          aria-label="批次处理进度"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 58 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.24 }}
        >
          <div className="cyber-batch-progress-copy">
            <span className="cyber-batch-phase"><i />{phaseLabel}</span>
            <strong>{percent}%</strong>
          </div>
          <Progress
            value={percent}
            role="progressbar"
            aria-label={`${phaseLabel} ${percent}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          />
          <small className="cyber-batch-file">
            {current}/{total || fileCount} 个文件
            {activePath ? ` · ${fileNameFromPath(activePath)}` : ""}
          </small>
          {actions}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

type WorkbenchPaginationProps = {
  itemCount: number;
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  onPageIndexChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

export function WorkbenchPagination({
  itemCount,
  pageIndex,
  pageSize,
  pageCount,
  onPageIndexChange,
  onPageSizeChange,
}: WorkbenchPaginationProps): React.JSX.Element {
  return (
    <footer className="cyber-pagination" aria-label="分页">
      <div className="cyber-pagination-info">
        {itemCount === 0
          ? "共 0 条"
          : `共 ${itemCount} 条 · 第 ${pageIndex * pageSize + 1}–${Math.min(
            (pageIndex + 1) * pageSize,
            itemCount,
          )} 条`}
      </div>
      <div className="cyber-pagination-nav" role="navigation" aria-label="页码">
        <button
          type="button"
          aria-label="上一页"
          disabled={pageIndex === 0}
          onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
        >
          <ChevronLeft />
        </button>
        <span className="cyber-pagination-page" aria-current="page">
          {pageIndex + 1}<em>/</em>{pageCount}
        </span>
        <button
          type="button"
          aria-label="下一页"
          disabled={pageIndex + 1 >= pageCount}
          onClick={() => onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))}
        >
          <ChevronRight />
        </button>
      </div>
      <div className="cyber-pagination-size">
        <span>每页</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value))}
        >
          <SelectTrigger className="pagination-size-select" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem value={String(size)} key={size}>{size} 条</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </footer>
  );
}
