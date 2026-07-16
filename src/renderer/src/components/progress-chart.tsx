import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { GaugeChart } from "echarts/charts";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([GaugeChart, CanvasRenderer]);

type ProgressChartProps = {
  value: number;
  color?: string;
};

export function ProgressChart({ value, color = "#3b82f6" }: ProgressChartProps): React.JSX.Element {
  const chartElementRef = useRef<HTMLDivElement>(null);
  const boundedValue = Math.max(0, Math.min(100, value));

  useEffect(() => {
    if (!chartElementRef.current || import.meta.env.MODE === "test") return undefined;
    const chart = echarts.init(chartElementRef.current, undefined, { renderer: "canvas", devicePixelRatio: 1 });
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(chartElementRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    if (!chartElementRef.current || import.meta.env.MODE === "test") return;
    const chart = echarts.getInstanceByDom(chartElementRef.current);
    chart?.setOption({
      animationDuration: 500,
      series: [{
        type: "gauge",
        startAngle: 90,
        endAngle: -270,
        radius: "92%",
        pointer: { show: false },
        progress: { show: true, width: 6, roundCap: true, itemStyle: { color } },
        axisLine: { lineStyle: { width: 6, color: [[1, color + "24"]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        detail: { show: false },
        title: { show: false },
        data: [{ value: boundedValue }],
      }],
    });
  }, [boundedValue, color]);

  return <div ref={chartElementRef} className="progress-chart" aria-hidden="true" />;
}
