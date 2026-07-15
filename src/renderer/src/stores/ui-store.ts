import { create } from "zustand";

export type FileTab = "pending" | "confirm" | "error" | "success";
export type ThemeMode = "light" | "dark";

type UIState = {
  activeTab: FileTab;
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  setActiveTab: (tab: FileTab) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
};

export const useUIStore = create<UIState>((set) => ({
  activeTab: "pending",
  theme: "dark",
  sidebarCollapsed: false,
  setActiveTab: (activeTab) => set({ activeTab }),
  toggleTheme: () => set((state) => ({ theme: state.theme === "light" ? "dark" : "light" })),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
