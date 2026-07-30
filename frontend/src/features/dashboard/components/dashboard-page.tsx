import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, ChartNoAxesCombined, CheckCircle2, FilePlus2, Files, FolderOpen, Gauge, Inbox, ListChecks, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HistoryTrendChart } from "@/features/history/components/history-trend-chart";
import type { DesktopAPI, TaskHistorySummary } from "../../../../../backend/electron/preload";

type DashboardPageProps = {
  api: DesktopAPI | null;
  dark: boolean;
  currentFileCount: number;
  outputDir: string;
  onNewProcessing: () => void;
  onOpenFiles: () => void;
  onOpenConfig: () => void;
};

const emptySummary: TaskHistorySummary = {
  today: { files: 0, tasks: 0, matchRate: 0, exceptions: 0 },
  trend: [],
  recent: [],
};

const statusLabels: Record<TaskHistorySummary["recent"][number]["status"], string> = {
  running: "处理中",
  awaiting_confirmation: "待处理",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};

export function DashboardPage({ api, dark, currentFileCount, outputDir, onNewProcessing, onOpenFiles, onOpenConfig }: DashboardPageProps): React.JSX.Element {
  const [summary, setSummary] = useState(emptySummary);
  const [configHealth, setConfigHealth] = useState<{ healthy: boolean; label: string }>({ healthy: false, label: "正在检查" });

  useEffect(() => {
    let cancelled = false;
    if (!api) return;
    void Promise.all([api.getTaskHistorySummary(), api.getConfigDocument()]).then(async ([history, document]) => {
      const validation = await api.validateConfigDocument(document.content);
      if (cancelled) return;
      setSummary(history);
      setConfigHealth({ healthy: validation.valid, label: validation.valid ? "配置可用" : `${validation.issues.length} 项需要处理` });
    }).catch(() => {
      if (!cancelled) setConfigHealth({ healthy: false, label: "配置读取失败" });
    });
    return () => { cancelled = true; };
  }, [api]);

  const hasTodayData = summary.today.files > 0 || summary.today.tasks > 0;
  const hasTrendData = summary.trend.some((item) => item.files > 0);
  const metrics = [
    { label: "今日处理量", value: summary.today.files || "—", suffix: summary.today.files ? "个文件" : "尚无文件", icon: Files, tone: "info" },
    { label: "今日任务", value: summary.today.tasks || "—", suffix: summary.today.tasks ? "个批次" : "尚无批次", icon: ListChecks, tone: "confirm" },
    { label: "平均匹配率", value: hasTodayData ? `${Math.round(summary.today.matchRate * 100)}%` : "—", suffix: hasTodayData ? "今日数据" : "处理后计算", icon: Gauge, tone: "success" },
    { label: "异常数据", value: hasTodayData ? summary.today.exceptions : "—", suffix: hasTodayData ? "行待处理" : "暂无待处理行", icon: AlertTriangle, tone: "error" },
  ];

  return (
    <div className="dashboard-page" role="region" aria-label="工作台">
      <section className="dashboard-metrics" aria-label="今日业务指标">
        {metrics.map(({ label, value, suffix, icon: Icon, tone }) => <article className={`is-${tone}`} key={label}><div><span className="dashboard-metric-icon"><Icon /></span><span>{label}</span></div><strong>{value}</strong><small>{suffix}</small></article>)}
      </section>

      <section className="dashboard-grid">
        <article className="dashboard-card dashboard-trend">
          <header><h2>处理趋势</h2><small>按导入文件数统计</small></header>
          {hasTrendData
            ? <HistoryTrendChart trend={summary.trend} dark={dark} />
            : <div className="dashboard-empty dashboard-trend-empty"><ChartNoAxesCombined /><strong>暂无处理数据</strong><span>完成首次核价后开始统计趋势</span></div>}
        </article>
        <article className="dashboard-card dashboard-health">
          <header><h2>配置健康状态</h2></header>
          <div className={configHealth.healthy ? "is-healthy" : "is-warning"}>{configHealth.healthy ? <CheckCircle2 /> : <AlertTriangle />}<div><strong>{configHealth.label}</strong><span>{configHealth.healthy ? "规则文件已加载并通过校验" : "进入配置检查查看具体问题"}</span></div></div>
          <Button variant="outline" onClick={onOpenConfig}><Settings2 />配置检查<ArrowRight /></Button>
        </article>
      </section>

      <section className="dashboard-grid dashboard-lower">
        <article className="dashboard-card dashboard-recent">
          <header>
            <h2>最近任务</h2>
            <div className="dashboard-recent-actions">
              <Button onClick={onNewProcessing}><FilePlus2 />新建处理</Button>
              <Button variant="ghost" onClick={onOpenFiles}>{currentFileCount ? `${currentFileCount} 个文件待处理` : "查看文件处理"}<ArrowRight /></Button>
            </div>
          </header>
          <div className="dashboard-task-list">
            {summary.recent.length === 0 ? <div className="dashboard-empty"><Inbox /><strong>还没有任务记录</strong><span>完成一次核价后会显示在这里</span></div> : summary.recent.map((task) => <div key={task.id}><span className={`is-${task.status}`}>{statusLabels[task.status]}</span><div><strong>{task.totalFiles} 个文件</strong><small>{new Date(task.startedAt).toLocaleString("zh-CN")}</small></div><em>{task.totalRows ? `${Math.round(task.matchedRows / task.totalRows * 100)}%` : "—"}</em></div>)}
          </div>
        </article>
        <article className="dashboard-card dashboard-shortcuts">
          <header><h2>配置与输出</h2></header>
          <button type="button" onClick={onOpenConfig}><Settings2 /><span><strong>查看规则配置</strong><small>当前使用的核价规则</small></span><ArrowRight /></button>
          <button type="button" onClick={() => outputDir && void api?.openPath(outputDir)} disabled={!outputDir}><FolderOpen /><span><strong>打开输出目录</strong><small>{outputDir || "尚未选择目录"}</small></span><ArrowRight /></button>
        </article>
      </section>
    </div>
  );
}
