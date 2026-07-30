import * as React from "react";
import { cn } from "@/lib/utils";

export function Progress({ value = 0, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { value?: number }): React.JSX.Element {
  const boundedValue = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/15", className)} {...props}>
      <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${boundedValue}%` }} />
    </div>
  );
}
