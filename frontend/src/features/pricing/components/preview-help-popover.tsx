import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const SKU_PAIR_SHADE_STRENGTHS = [38, 32, 26, 20, 14];

type PreviewHelpPopoverProps = {
  issueNavigationAvailable: boolean;
  mappingSelectionActive: boolean;
  orderSheetActive: boolean;
  showsWritebackColumns: boolean;
  skuQuantityPairCount: number;
};

export function PreviewHelpPopover({
  issueNavigationAvailable,
  mappingSelectionActive,
  orderSheetActive,
  showsWritebackColumns,
  skuQuantityPairCount,
}: PreviewHelpPopoverProps): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="excel-preview-help-trigger" aria-label="查看全部预览提示">
          <CircleHelp />
          <span>预览提示</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="excel-preview-help-popover" side="top" align="start">
        <section aria-labelledby="preview-color-help-title">
          <h3 id="preview-color-help-title">颜色图例</h3>
          <div className="excel-preview-help-legend">
            {orderSheetActive
              ? Array.from({ length: skuQuantityPairCount }, (_, index) => (
                  <span key={index}>
                    <i
                      className="is-sku-qty"
                      style={{ "--sku-pair-strength": `${SKU_PAIR_SHADE_STRENGTHS[Math.min(index, SKU_PAIR_SHADE_STRENGTHS.length - 1)]}%` } as React.CSSProperties}
                    />
                    SKU/数量 {index + 1}
                  </span>
                ))
              : <span><i className="is-sku" />SKU 字段</span>}
            <span><i className="is-price" />价格字段</span>
            <span><i className="is-mapped" />常规匹配字段</span>
            {showsWritebackColumns ? <span><i className="is-writeback" />写回结果</span> : null}
            {showsWritebackColumns ? <span><i className="is-alert" />金额差为正/数量异常</span> : null}
            {showsWritebackColumns ? <span><i className="is-negative-difference" />金额差为负</span> : null}
            {showsWritebackColumns ? <span><i className="is-original-sku-quantity" />原始 SKU/数量</span> : null}
            {orderSheetActive ? <span><i className="is-matched-row" />已匹配行号</span> : null}
            {issueNavigationAvailable ? <span><i className="is-unmatched-row" />当前异常定位行</span> : null}
          </div>
        </section>
        <section aria-labelledby="preview-operation-help-title">
          <h3 id="preview-operation-help-title">操作提示</h3>
          <ul>
            {showsWritebackColumns ? <li>双击核价、金额差或数量写回格可修改；Enter 保存，Esc 取消。</li> : null}
            <li>点击表头图钉可冻结或取消冻结列；拖动表头右侧分隔线可调整列宽。</li>
            <li>Ctrl+F 打开搜索；Enter 或 ↓ 查看下一个，Shift+Enter 或 ↑ 查看上一个，Esc 关闭。</li>
            {issueNavigationAvailable ? <li>Ctrl+E 开关异常定位；↑↓ 切换异常行，Enter 查看该行可用详情。</li> : null}
            {orderSheetActive ? <li>定位范围的筛选结果会全局保存，并在下次打开详情时恢复。</li> : null}
            {mappingSelectionActive ? <li>点击列头或单元格，将当前列映射到正在选择的字段。</li> : null}
          </ul>
        </section>
      </PopoverContent>
    </Popover>
  );
}
