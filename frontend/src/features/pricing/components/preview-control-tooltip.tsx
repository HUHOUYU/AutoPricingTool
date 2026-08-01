import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type PreviewControlTooltipProps = {
  label: string;
  children: ReactElement;
};

export function PreviewControlTooltip({
  label,
  children,
}: PreviewControlTooltipProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" collisionPadding={8} className="excel-preview-control-tooltip">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
