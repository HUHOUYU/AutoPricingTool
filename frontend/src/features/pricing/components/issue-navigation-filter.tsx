import { ListFilter } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ISSUE_NAVIGATION_KINDS,
  type IssueNavigationKind,
  type IssueNavigationRows,
} from "../issue-navigation";

const FILTER_LABELS: Record<IssueNavigationKind, string> = {
  unmatched: "未匹配行",
  difference: "金额差",
  quantity: "数量异常",
};

type IssueNavigationFilterProps = {
  disabled: boolean;
  rowsByKind: IssueNavigationRows;
  selectedKinds: readonly IssueNavigationKind[];
  onToggle: (kind: IssueNavigationKind) => void;
};

export function IssueNavigationFilter({
  disabled,
  rowsByKind,
  selectedKinds,
  onToggle,
}: IssueNavigationFilterProps): React.JSX.Element {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="excel-preview-issue-filter-trigger"
              aria-label="选择异常定位类型"
              disabled={disabled}
            >
              <ListFilter />
              <strong>定位范围</strong>
              <span>{selectedKinds.length}/3</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" collisionPadding={8} className="excel-preview-control-tooltip">
          选择异常定位类型
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="excel-preview-issue-filter-popover" align="end">
        <div role="group" aria-label="异常定位类型">
          {ISSUE_NAVIGATION_KINDS.map((kind) => (
            <label key={kind}>
              <Checkbox
                checked={selectedKinds.includes(kind)}
                onCheckedChange={() => onToggle(kind)}
                aria-label={FILTER_LABELS[kind]}
              />
              <span>{FILTER_LABELS[kind]}</span>
              <strong>{rowsByKind[kind].length}</strong>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
