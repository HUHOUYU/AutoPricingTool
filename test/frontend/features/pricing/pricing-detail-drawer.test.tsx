import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PricingDetailDrawer } from "@/features/pricing/components/pricing-detail-drawer";
import type { PricingDetailState } from "@/features/pricing/hooks/use-pricing-detail-state";
import type { MappingDetailActions } from "@/features/pricing/hooks/use-mapping-detail-actions";
import type { DetailDrawerLayoutState } from "@/features/workbench/hooks/use-detail-drawer-layout";

const state = {
  activeMappingTarget: null,
  analysis: null,
  closeIssueDetails: vi.fn(),
  contentReady: false,
  issueDetailsRequest: null,
  mapping: null,
  matchedOrderRows: [],
  openSelectedRowDetails: vi.fn(),
  openUnmatchedDetails: vi.fn(),
  previewCandidates: [],
  previewSheetName: "",
  previewWorkbook: null,
  quantityIssues: [],
  result: null,
  setPreviewSheetName: vi.fn(),
  setPreviewWorkbook: vi.fn(),
  singleShipmentMatchingEnabled: false,
  unmatchedIssues: [],
  validation: null,
  writebackRows: [],
} as unknown as PricingDetailState;

const layout = {
  drawerBounds: { min: 520, max: 1200 },
  drawerWidth: 900,
  sidebarBounds: { min: 280, max: 500 },
  sidebarWidth: 360,
  resetDrawerWidth: vi.fn(),
  resizeDrawerWithKeyboard: vi.fn(),
  resizeSidebarWithKeyboard: vi.fn(),
  startDrawerResize: vi.fn(),
  startSidebarResize: vi.fn(),
} as unknown as DetailDrawerLayoutState;

const mappingActions = {
  editDetailWritebackRow: vi.fn(),
  selectMappingTarget: vi.fn(),
  changeMappingColumn: vi.fn(),
  selectMappingColumn: vi.fn(),
  selectMappingRow: vi.fn(),
} as unknown as MappingDetailActions;

describe("PricingDetailDrawer", () => {
  it("renders the loading shell and routes close actions", () => {
    const onClose = vi.fn();
    render(
      <PricingDetailDrawer
        path="C:\\orders\\a.xlsx"
        fileStatus={undefined}
        cellEdits={[]}
        state={state}
        layout={layout}
        mappingActions={mappingActions}
        onClose={onClose}
        onRevalidate={vi.fn()}
        onUseOriginalSkuQuantity={vi.fn()}
        onCommitMapping={vi.fn()}
        onUpdateMapping={vi.fn()}
        onConfirm={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "文件处理详情" })).toBeInTheDocument();
    expect(screen.getByText("a.xlsx")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在准备文件详情" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭文件详情" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render when no detail path is selected", () => {
    render(
      <PricingDetailDrawer
        path={null}
        fileStatus={undefined}
        cellEdits={[]}
        state={state}
        layout={layout}
        mappingActions={mappingActions}
        onClose={vi.fn()}
        onRevalidate={vi.fn()}
        onUseOriginalSkuQuantity={vi.fn()}
        onCommitMapping={vi.fn()}
        onUpdateMapping={vi.fn()}
        onConfirm={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog", { name: "文件处理详情" })).not.toBeInTheDocument();
  });
});
