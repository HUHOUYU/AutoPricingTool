import { create } from "zustand";

export type FileTab = "pending" | "queued" | "confirm" | "error" | "success";
export type ThemeMode = "light" | "dark";
export type WorkbenchPage = "workbench" | "files" | "config" | "rules" | "templates" | "logs" | "analytics";

type UIState = {
  activeTab: FileTab;
  activePage: WorkbenchPage;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  setActiveTab: (tab: FileTab) => void;
  setActivePage: (page: WorkbenchPage) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
};

export const useUIStore = create<UIState>((set) => ({
  activeTab: "pending",
  activePage: "workbench",
  theme: "light",
  sidebarCollapsed: false,
  setActiveTab: (activeTab) => set({ activeTab }),
  setActivePage: (activePage) => set({ activePage }),
  toggleTheme: () => set((state) => ({ theme: state.theme === "light" ? "dark" : "light" })),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
