import {
  CircleStop,
  FileCheck2,
  FilePlus2,
  Pause,
  Play,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { SidebarTooltip } from "@/app/components/sidebar-tooltip";

export type TaskNextAction = {
  className: string;
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
  onFinishBatch: () => void;
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
  onFinishBatch,
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
        <button type="button" aria-label={nextAction.label} className={nextAction.className} onClick={nextAction.onClick}>
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
        <button type="button" aria-label="结束本批并处理下一批" className="cyber-action is-reset" onClick={onFinishBatch}>
          <FilePlus2 />
          <strong>结束并下一批</strong>
        </button>
      ) : null}
    </div>
  );
}
