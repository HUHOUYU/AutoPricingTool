import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, FilePlus2, Files, FolderOpen, Gauge, ListChecks, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HistoryTrendChart } from "@/components/history-trend-chart";
import type { DesktopAPI, TaskHistorySummary } from "../../../preload";

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

  const metrics = [
    { label: "今日处理量", value: summary.today.files, suffix: "个文件", icon: Files },
    { label: "今日任务", value: summary.today.tasks, suffix: "个批次", icon: ListChecks },
    { label: "平均匹配率", value: `${Math.round(summary.today.matchRate * 100)}%`, suffix: "今日数据", icon: Gauge },
    { label: "异常数据", value: summary.today.exceptions, suffix: "行待处理", icon: AlertTriangle },
  ];

  return (
    <div className="dashboard-page">
      <header className="dashboard-hero">
        <div><span>业务总览</span><h1>工作台</h1><p>查看核价进展、配置健康状态与最近任务。</p></div>
        <Button onClick={onNewProcessing}><FilePlus2 />新建处理</Button>
      </header>

      <section className="dashboard-metrics" aria-label="今日业务指标">
        {metrics.map(({ label, value, suffix, icon: Icon }) => <article key={label}><div><Icon /></div><span>{label}</span><strong>{value}</strong><small>{suffix}</small></article>)}
      </section>

      <section className="dashboard-grid">
        <article className="dashboard-card dashboard-trend">
          <header><div><span>处理趋势</span><h2>最近 7 天</h2></div><small>按导入文件数统计</small></header>
          <HistoryTrendChart trend={summary.trend} dark={dark} />
        </article>
        <article className="dashboard-card dashboard-health">
          <header><div><span>运行准备</span><h2>配置健康状态</h2></div></header>
          <div className={configHealth.healthy ? "is-healthy" : "is-warning"}>{configHealth.healthy ? <CheckCircle2 /> : <AlertTriangle />}<div><strong>{configHealth.label}</strong><span>{configHealth.healthy ? "规则文件已加载并通过校验" : "进入配置检查查看具体问题"}</span></div></div>
          <Button variant="outline" onClick={onOpenConfig}><Settings2 />配置检查<ArrowRight /></Button>
        </article>
      </section>

      <section className="dashboard-grid dashboard-lower">
        <article className="dashboard-card dashboard-recent">
          <header><div><span>任务记录</span><h2>最近任务</h2></div><Button variant="ghost" onClick={onOpenFiles}>查看文件处理<ArrowRight /></Button></header>
          <div className="dashboard-task-list">
            {summary.recent.length === 0 ? <div className="dashboard-empty">暂无任务记录，完成一次核价后会显示在这里。</div> : summary.recent.map((task) => <div key={task.id}><span className={`is-${task.status}`}>{statusLabels[task.status]}</span><div><strong>{task.totalFiles} 个文件</strong><small>{new Date(task.startedAt).toLocaleString("zh-CN")}</small></div><em>{task.totalRows ? `${Math.round(task.matchedRows / task.totalRows * 100)}%` : "—"}</em></div>)}
          </div>
        </article>
        <article className="dashboard-card dashboard-shortcuts">
          <header><div><span>快捷入口</span><h2>继续工作</h2></div></header>
          <button type="button" onClick={onNewProcessing}><FilePlus2 /><span><strong>新建处理</strong><small>导入新的 Excel 批次</small></span><ArrowRight /></button>
          <button type="button" onClick={onOpenFiles} disabled={currentFileCount === 0}><ListChecks /><span><strong>继续当前批次</strong><small>{currentFileCount ? `${currentFileCount} 个文件待处理` : "当前没有文件"}</small></span><ArrowRight /></button>
          <button type="button" onClick={() => outputDir && void api?.openPath(outputDir)} disabled={!outputDir}><FolderOpen /><span><strong>打开输出目录</strong><small>{outputDir || "尚未选择目录"}</small></span><ArrowRight /></button>
        </article>
      </section>
    </div>
  );
}
