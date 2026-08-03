import {
  Archive,
  CircleStop,
  FileCheck2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { SidebarTooltip } from "@/app/components/sidebar-tooltip";

export type TaskNextAction = {
  className: string;
  description?: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
};

type TaskActionsProps = {
  batchStarted: boolean;
  canReset: boolean;
  canStart: boolean;
  className: string;
  collapsed: boolean;
  isPaused: boolean;
  isTaskActive: boolean;
  nextAction: TaskNextAction | null;
  pendingReviewCount: number;
  showNext?: boolean;
  showReset?: boolean;
  onArchiveBatch: () => void;
  onDiscardBatch: () => void;
  onPause: () => void;
  onReset: () => void;
  onStart: () => void;
  onStop: () => void;
};

export function TaskActions({
  batchStarted,
  canReset,
  canStart,
  className,
  collapsed,
  isPaused,
  isTaskActive,
  nextAction,
  pendingReviewCount,
  showNext = false,
  showReset = false,
  onArchiveBatch,
  onDiscardBatch,
  onPause,
  onReset,
  onStart,
  onStop,
}: TaskActionsProps): React.JSX.Element {
  const NextIcon = nextAction?.icon ?? FileCheck2;
  const pauseLabel = isPaused ? "继续任务" : "暂停任务";

  return (
    <div className={className} aria-label="快捷操作">
      {!batchStarted ? (
        <SidebarTooltip label="开始处理" enabled={collapsed}>
          <button
            type="button"
            aria-label="开始处理"
            className="cyber-action is-start"
            onClick={onStart}
            disabled={!canStart || isTaskActive}
          >
            <Play />
            <strong>开始处理</strong>
          </button>
        </SidebarTooltip>
      ) : null}

      {isTaskActive ? (
        <SidebarTooltip label={pauseLabel} enabled={collapsed}>
          <button type="button" aria-label={pauseLabel} className="cyber-action is-pause" onClick={onPause}>
            {isPaused ? <Play /> : <Pause />}
            <strong>{pauseLabel}</strong>
          </button>
        </SidebarTooltip>
      ) : null}

      {isTaskActive ? (
        <SidebarTooltip label="停止任务" enabled={collapsed}>
          <button type="button" aria-label="停止任务" className="cyber-action is-stop" onClick={onStop}>
            <CircleStop />
            <strong>停止任务</strong>
          </button>
        </SidebarTooltip>
      ) : null}

      {showNext && nextAction ? (
        <button
          type="button"
          aria-label={nextAction.label}
          title={nextAction.description}
          className={nextAction.className}
          onClick={nextAction.onClick}
        >
          <NextIcon />
          <strong>{nextAction.label}</strong>
        </button>
      ) : null}

      {showReset && !batchStarted ? (
        <button type="button" aria-label="重置本批" className="cyber-action is-reset" onClick={onReset} disabled={!canReset}>
          <RefreshCw />
          <strong>重置本批</strong>
        </button>
      ) : null}

      {showReset && batchStarted && !isTaskActive && pendingReviewCount > 0 ? (
        <>
          <button
            type="button"
            aria-label="保存本批并处理下一批"
            title="保留已生成结果，并将未完成原文件归档后进入下一批"
            className="cyber-action is-save"
            onClick={onArchiveBatch}
          >
            <Archive />
            <strong>保存并下一批</strong>
          </button>
          <button
            type="button"
            aria-label="丢弃本批并处理下一批"
            title="当前批次尚未全部完成，继续前需要确认丢弃"
            className="cyber-action is-reset"
            onClick={onDiscardBatch}
          >
            <Trash2 />
            <strong>丢弃并下一批</strong>
          </button>
        </>
      ) : null}
    </div>
  );
}
