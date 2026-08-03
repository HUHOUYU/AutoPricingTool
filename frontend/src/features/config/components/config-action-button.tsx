import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ConfigActionButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  icon: LucideIcon;
  label: string;
};

export function ConfigActionButton({
  icon: Icon,
  label,
  ...buttonProps
}: ConfigActionButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} title={label} {...buttonProps}>
          <Icon />
          <span className="config-action-label">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
