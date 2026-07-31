import type { ReactNode, RefObject } from "react";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ThemeMode, WorkbenchPage } from "@/stores/ui-store";
import { AppSidebar } from "./app-sidebar";
import { AppTitlebar } from "./app-titlebar";

type AppShellProps = {
  mainRef: RefObject<HTMLElement | null>;
  theme: ThemeMode;
  activePage: WorkbenchPage;
  sidebarCollapsed: boolean;
  detailOpen: boolean;
  railActions?: ReactNode;
  children: ReactNode;
  onChangePage: (page: WorkbenchPage) => void;
  onHelp: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
};

export function AppShell({
  mainRef,
  theme,
  activePage,
  sidebarCollapsed,
  detailOpen,
  railActions,
  children,
  onChangePage,
  onHelp,
  onToggleSidebar,
  onToggleTheme,
}: AppShellProps): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={220} skipDelayDuration={80}>
      <MotionConfig reducedMotion="user">
        <main
          className={"cyber-app"
            + (sidebarCollapsed ? " is-sidebar-collapsed" : "")
            + (detailOpen ? " is-detail-open" : "")}
          ref={mainRef}
        >
          <Toaster
            className="cyber-toaster"
            position="top-left"
            closeButton
            expand
            visibleToasts={5}
            theme={theme}
            duration={1_000}
            gap={8}
            offset={16}
            toastOptions={{
              classNames: {
                toast: "cyber-toast",
                title: "cyber-toast-title",
                icon: "cyber-toast-icon",
                closeButton: "cyber-toast-close",
              },
            }}
          />
          <AppTitlebar />
          <AppSidebar
            activePage={activePage}
            collapsed={sidebarCollapsed}
            railActions={railActions}
            theme={theme}
            onChangePage={onChangePage}
            onHelp={onHelp}
            onToggleCollapsed={onToggleSidebar}
            onToggleTheme={onToggleTheme}
          />
          {children}
        </main>
      </MotionConfig>
    </TooltipProvider>
  );
}
