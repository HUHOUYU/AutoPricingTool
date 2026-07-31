import { LayoutDashboard } from "lucide-react";
import type {
  AppPreferences,
  AppState,
  ConfigDocument,
} from "@shared/desktop-api";
import { Button } from "@/components/ui/button";
import { navigationItems } from "@/app/navigation";
import { AnalyticsPage } from "@/features/analytics/components/analytics-page";
import { ConfigCenterPage } from "@/features/config/components/config-center-page";
import { DashboardPage } from "@/features/dashboard/components/dashboard-page";
import { LogCenterPage } from "@/features/history/components/log-center-page";
import { TemplateManagementPage } from "@/features/templates/components/template-management-page";
import { getDesktopAPI } from "@/features/workbench/file-utils";
import type { WorkbenchPage } from "@/stores/ui-store";

type AppPageContentProps = {
  activePage: Exclude<WorkbenchPage, "files">;
  dark: boolean;
  currentFileCount: number;
  outputDir: string;
  historyRevision: number;
  requestedHistoryBatchId: string | null;
  onChangePage: (page: WorkbenchPage) => void;
  onNewProcessing: () => void;
  onConfigDocumentSaved: (document: ConfigDocument) => void | Promise<void>;
  onAppSettingsChanged: (preferences: AppPreferences, state: AppState) => void;
  onRequestedBatchHandled: () => void;
  onOpenBatch: (batchId: string) => void;
};

export function AppPageContent({
  activePage,
  dark,
  currentFileCount,
  outputDir,
  historyRevision,
  requestedHistoryBatchId,
  onChangePage,
  onNewProcessing,
  onConfigDocumentSaved,
  onAppSettingsChanged,
  onRequestedBatchHandled,
  onOpenBatch,
}: AppPageContentProps): React.JSX.Element {
  if (activePage === "workbench") {
    return (
      <DashboardPage
        api={getDesktopAPI()}
        dark={dark}
        currentFileCount={currentFileCount}
        outputDir={outputDir}
        onNewProcessing={onNewProcessing}
        onOpenFiles={() => onChangePage("files")}
        onOpenConfig={() => onChangePage("config")}
      />
    );
  }

  if (activePage === "config") {
    return (
      <ConfigCenterPage
        api={getDesktopAPI()}
        onDocumentSaved={onConfigDocumentSaved}
        onAppSettingsChanged={onAppSettingsChanged}
      />
    );
  }

  if (activePage === "templates") {
    return <TemplateManagementPage api={getDesktopAPI()} />;
  }

  if (activePage === "logs") {
    return (
      <LogCenterPage
        api={getDesktopAPI()}
        revision={historyRevision}
        requestedBatchId={requestedHistoryBatchId}
        onRequestedBatchHandled={onRequestedBatchHandled}
      />
    );
  }

  if (activePage === "analytics") {
    return (
      <AnalyticsPage
        api={getDesktopAPI()}
        dark={dark}
        revision={historyRevision}
        onOpenBatch={onOpenBatch}
      />
    );
  }

  const activeNavigationItem = navigationItems.find((item) => item.key === activePage) ?? navigationItems[0];
  const ActiveNavigationIcon = activeNavigationItem.icon;

  return (
    <section className="coming-soon-page" aria-labelledby="coming-soon-title">
      <div className="coming-soon-icon" aria-hidden="true">
        <ActiveNavigationIcon />
      </div>
      <span className="coming-soon-eyebrow">{activeNavigationItem.label}</span>
      <h1 id="coming-soon-title">正在装修中</h1>
      <p>该功能页面正在设计和开发，后续版本将逐步开放。</p>
      <Button
        type="button"
        className="coming-soon-back"
        onClick={() => onChangePage("workbench")}
      >
        <LayoutDashboard />返回工作台
      </Button>
    </section>
  );
}
