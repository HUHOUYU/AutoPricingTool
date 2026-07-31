import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppPageContent } from "@/app/components/app-page-content";

describe("AppPageContent", () => {
  it("renders the routed placeholder and returns to the workbench", () => {
    const onChangePage = vi.fn();
    render(
      <AppPageContent
        activePage="rules"
        dark={false}
        currentFileCount={0}
        outputDir=""
        historyRevision={0}
        requestedHistoryBatchId={null}
        onChangePage={onChangePage}
        onNewProcessing={vi.fn()}
        onConfigDocumentSaved={vi.fn()}
        onAppSettingsChanged={vi.fn()}
        onRequestedBatchHandled={vi.fn()}
        onOpenBatch={vi.fn()}
      />,
    );

    expect(screen.getByText("规则管理")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "正在装修中" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(onChangePage).toHaveBeenCalledWith("workbench");
  });
});
