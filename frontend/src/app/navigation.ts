import {
  BarChart3,
  FileCheck2,
  FileClock,
  FileCog,
  LayoutDashboard,
  Settings2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { WorkbenchPage } from "@/stores/ui-store";

export const navigationItems: Array<{
  key: WorkbenchPage;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "workbench", label: "工作台", icon: LayoutDashboard },
  { key: "files", label: "文件处理", icon: FileCheck2 },
  { key: "templates", label: "模板管理", icon: FileCog },
  { key: "config", label: "配置中心", icon: Settings2 },
  { key: "rules", label: "规则管理", icon: Workflow },
  { key: "logs", label: "日志中心", icon: FileClock },
  { key: "analytics", label: "数据统计", icon: BarChart3 },
];
