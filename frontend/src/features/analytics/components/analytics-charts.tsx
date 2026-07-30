import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { TaskAnalyticsSummary } from "../../../../../backend/electron/preload";

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type AnalyticsChartProps = {
  data: TaskAnalyticsSummary;
  dark: boolean;
  kind: "trend" | "status" | "issues";
};

const STATUS_LABELS: Record<TaskAnalyticsSummary["statuses"][number]["status"], string> = {
  running: "处理中",
  awaiting_confirmation: "待处理",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};
const STATUS_COLORS: Record<TaskAnalyticsSummary["statuses"][number]["status"], string> = {
  running: "#3e8ed0",
  awaiting_confirmation: "#d8932f",
  completed: "#4f6fdf",
  failed: "#9dce2b",
  stopped: "#d8932f",
  interrupted: "#d94a3a",
};

export function AnalyticsChart({ data, dark, kind }: AnalyticsChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || navigator.userAgent.includes("jsdom")) return;
    const chart = echarts.init(containerRef.current);
    const textColor = dark ? "#c7c1b8" : "#6f675d";
    const gridColor = dark ? "rgba(255,255,255,.08)" : "rgba(29,27,22,.08)";
    const accent = "#df8060";
    const info = "#3e8ed0";
    if (kind === "trend") {
      chart.setOption({
        animationDuration: 450,
        grid: { top: 42, right: 46, bottom: 30, left: 48 },
        legend: { top: 4, textStyle: { color: textColor } },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: data.trend.map((item) => item.date.slice(5)),
          axisLabel: { color: textColor },
          axisLine: { lineStyle: { color: gridColor } },
          axisTick: { show: false },
        },
        yAxis: [
          { type: "value", minInterval: 1, axisLabel: { color: textColor }, splitLine: { lineStyle: { color: gridColor } } },
          { type: "value", min: 0, max: 100, axisLabel: { color: textColor, formatter: "{value}%" }, splitLine: { show: false } },
        ],
        series: [
          {
            name: "处理文件",
            type: "bar",
            barMaxWidth: 26,
            data: data.trend.map((item) => item.files),
            itemStyle: { color: accent, borderRadius: [5, 5, 0, 0] },
          },
          {
            name: "匹配率",
            type: "line",
            yAxisIndex: 1,
            smooth: 0.3,
            symbolSize: 6,
            data: data.trend.map((item) => item.matchRate === null ? null : Number((item.matchRate * 100).toFixed(2))),
            lineStyle: { color: info, width: 3 },
            itemStyle: { color: info },
          },
        ],
      });
    } else if (kind === "status") {
      const statusCountByLabel = new Map(data.statuses.map((item) => [STATUS_LABELS[item.status], item.count]));
      chart.setOption({
        animationDuration: 450,
        tooltip: { trigger: "item" },
        legend: {
          bottom: 0,
          textStyle: { color: textColor },
          formatter: (name: string) => `${name} ${statusCountByLabel.get(name) ?? 0}`,
        },
        series: [{
          type: "pie",
          radius: ["40%", "62%"],
          center: ["50%", "46%"],
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: dark ? "#24211e" : "#fffdf9", borderWidth: 3 },
          data: data.statuses.filter((item) => item.count > 0).map((item) => ({
            name: STATUS_LABELS[item.status],
            value: item.count,
            itemStyle: {
              color: STATUS_COLORS[item.status],
              borderWidth: item.status === "completed" ? 3 : 1,
            },
            label: {
              show: item.status !== "completed",
              formatter: "{c}",
              color: textColor,
              position: "outside",
              distanceToLabelLine: 2,
            },
            labelLine: {
              show: item.status !== "completed",
              length: 6,
              length2: 4,
            },
          })),
        }],
      });
    } else {
      chart.setOption({
        animationDuration: 450,
        grid: { top: 12, right: 30, bottom: 24, left: 96 },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        xAxis: { type: "value", minInterval: 1, axisLabel: { color: textColor }, splitLine: { lineStyle: { color: gridColor } } },
        yAxis: {
          type: "category",
          inverse: true,
          data: data.issues.slice(0, 7).map((item) => item.label),
          axisLabel: { color: textColor },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          type: "bar",
          barMaxWidth: 20,
          data: data.issues.slice(0, 7).map((item) => item.count),
          itemStyle: { color: accent, borderRadius: [0, 5, 5, 0] },
          label: { show: true, position: "right", color: textColor },
        }],
      });
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chart.resize());
    observer?.observe(containerRef.current);
    const handleResize = (): void => chart.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleResize);
      chart.dispose();
    };
  }, [dark, data, kind]);

  const label = kind === "trend" ? "每日处理文件与匹配率趋势" : kind === "status" ? "批次状态分布" : "异常原因排行";
  return <div className={`analytics-chart is-${kind}`} ref={containerRef} role="img" aria-label={label} />;
}
