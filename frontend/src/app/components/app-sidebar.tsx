import type { ReactNode } from "react";
import { CircleHelp, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun } from "lucide-react";
import brandExcelUrl from "@/assets/brand-excel.png";
import { navigationItems } from "@/app/navigation";
import { SidebarTooltip } from "@/app/components/sidebar-tooltip";
import type { ThemeMode, WorkbenchPage } from "@/stores/ui-store";

type AppSidebarProps = {
  activePage: WorkbenchPage;
  collapsed: boolean;
  railActions?: ReactNode;
  theme: ThemeMode;
  onChangePage: (page: WorkbenchPage) => void;
  onHelp: () => void;
  onToggleCollapsed: () => void;
  onToggleTheme: () => void;
};

export function AppSidebar({
  activePage,
  collapsed,
  railActions,
  theme,
  onChangePage,
  onHelp,
  onToggleCollapsed,
  onToggleTheme,
}: AppSidebarProps): React.JSX.Element {
  const themeLabel = theme === "dark" ? "切换到浅色主题" : "切换到深色主题";
  const sidebarLabel = collapsed ? "展开侧栏" : "折叠侧栏";

  return (
    <aside className="cyber-sidebar">
      <div className="cyber-brand">
        <img src={brandExcelUrl} alt="" />
        <div>
          <strong>Excel 批量核价</strong>
          <span>快速 · 准确</span>
        </div>
      </div>

      <nav className="cyber-nav" aria-label="主导航">
        {navigationItems.map(({ key, label, icon: Icon }) => {
          const isActive = activePage === key;
          return (
            <SidebarTooltip label={label} enabled={collapsed} key={key}>
              <button
                type="button"
                className={isActive ? "is-active" : undefined}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onChangePage(key)}
              >
                <Icon />
                <span>{label}</span>
              </button>
            </SidebarTooltip>
          );
        })}
      </nav>

      {railActions}

      <div className="cyber-sidebar-tools">
        <SidebarTooltip label="配置中心" enabled={collapsed}>
          <button type="button" aria-label="配置中心" onClick={() => onChangePage("config")}>
            <Settings />
          </button>
        </SidebarTooltip>
        <SidebarTooltip label="帮助" enabled={collapsed}>
          <button type="button" aria-label="帮助" onClick={onHelp}>
            <CircleHelp />
          </button>
        </SidebarTooltip>
        <SidebarTooltip label={themeLabel} enabled={collapsed}>
          <button type="button" aria-label={themeLabel} onClick={onToggleTheme}>
            {theme === "dark" ? <Moon /> : <Sun />}
          </button>
        </SidebarTooltip>
        <SidebarTooltip label={sidebarLabel} enabled={collapsed}>
          <button type="button" aria-label={sidebarLabel} onClick={onToggleCollapsed}>
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </SidebarTooltip>
      </div>
    </aside>
  );
}
