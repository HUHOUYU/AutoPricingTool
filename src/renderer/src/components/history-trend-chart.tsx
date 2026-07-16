import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { TaskHistorySummary } from "../../../preload";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

type HistoryTrendChartProps = {
  trend: TaskHistorySummary["trend"];
  dark: boolean;
};

export function HistoryTrendChart({ trend, dark }: HistoryTrendChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || navigator.userAgent.includes("jsdom")) return;
    const chart = echarts.init(containerRef.current);
    const accent = "#da7756";
    const muted = dark ? "#9d9489" : "#776f64";
    const grid = dark ? "rgba(255,255,255,.08)" : "rgba(29,27,22,.08)";
    chart.setOption({
      animationDuration: 500,
      grid: { top: 24, right: 18, bottom: 28, left: 42 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: trend.map((item) => item.date.slice(5)),
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: muted },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: muted },
        splitLine: { lineStyle: { color: grid } },
      },
      series: [{
        name: "处理文件",
        type: "line",
        smooth: 0.35,
        symbolSize: 7,
        data: trend.map((item) => item.files),
        lineStyle: { color: accent, width: 3 },
        itemStyle: { color: accent },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(218,119,86,.30)" },
            { offset: 1, color: "rgba(218,119,86,.02)" },
          ]),
        },
      }],
    });

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chart.resize());
    observer?.observe(containerRef.current);
    const handleResize = (): void => chart.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleResize);
      chart.dispose();
    };
  }, [dark, trend]);

  return <div className="dashboard-trend-chart" ref={containerRef} role="img" aria-label="最近七天处理趋势" />;
}
