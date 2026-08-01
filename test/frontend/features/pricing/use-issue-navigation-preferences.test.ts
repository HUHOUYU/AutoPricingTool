import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useIssueNavigationPreferences } from "@/features/pricing/hooks/use-issue-navigation-preferences";
import type { AppPreferences } from "@shared/app-settings";
import type { DesktopAPI } from "@shared/desktop-api";

vi.mock("sonner", () => ({
  toast: { warning: vi.fn() },
}));

function preferences(issueNavigationKinds: AppPreferences["issueNavigationKinds"]): AppPreferences {
  return {
    schemaVersion: 1,
    archiveStandardFiles: false,
    autoRevealManualResult: false,
    continuousIssueReviewEnabled: false,
    issueNavigationKinds,
    overwriteSourceFiles: false,
    rememberWindowSize: false,
  };
}

function createAPI(initial: AppPreferences["issueNavigationKinds"]): Pick<DesktopAPI, "getAppPreferences" | "setAppPreferences"> {
  return {
    getAppPreferences: vi.fn(async () => preferences(initial)),
    setAppPreferences: vi.fn(async (update) => preferences(update.issueNavigationKinds ?? initial)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useIssueNavigationPreferences", () => {
  it("restores the global selection and persists ordered changes", async () => {
    const api = createAPI(["difference", "quantity"]);
    const { result } = renderHook(() => useIssueNavigationPreferences(api as DesktopAPI));

    await waitFor(() => expect(result.current.selectedIssueKinds).toEqual(["difference", "quantity"]));
    act(() => result.current.toggleIssueKind("unmatched"));

    expect(result.current.selectedIssueKinds).toEqual(["unmatched", "difference", "quantity"]);
    expect(api.setAppPreferences).toHaveBeenCalledWith({
      issueNavigationKinds: ["unmatched", "difference", "quantity"],
    });
  });

  it("preserves an explicitly empty persisted selection", async () => {
    const api = createAPI([]);
    const { result } = renderHook(() => useIssueNavigationPreferences(api as DesktopAPI));

    await waitFor(() => expect(result.current.selectedIssueKinds).toEqual([]));
  });

  it("keeps the session selection and warns when persistence fails", async () => {
    const api = createAPI(["unmatched"]);
    vi.mocked(api.setAppPreferences).mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useIssueNavigationPreferences(api as DesktopAPI));
    await waitFor(() => expect(result.current.selectedIssueKinds).toEqual(["unmatched"]));

    act(() => result.current.toggleIssueKind("difference"));

    expect(result.current.selectedIssueKinds).toEqual(["unmatched", "difference"]);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      "保存异常定位筛选偏好失败，本次选择仍然有效",
    ));
  });
});
