import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function SidebarTooltip({
  label,
  enabled,
  children,
}: {
  label: string;
  enabled: boolean;
  children: React.JSX.Element;
}): React.JSX.Element {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={10}
        collisionPadding={8}
        className="cyber-rail-tooltip"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
