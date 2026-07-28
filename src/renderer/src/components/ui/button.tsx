import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "ui-button inline-flex items-center justify-center whitespace-nowrap disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "",
        outline: "",
        ghost: "",
        destructive: "",
      },
      size: {
        default: "",
        sm: "",
        icon: "",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : "button";
    const resolvedVariant = variant ?? "default";
    const resolvedSize = size ?? "default";
    return (
      <Component
        ref={ref}
        data-variant={resolvedVariant}
        data-size={resolvedSize}
        className={cn(buttonVariants({ variant: resolvedVariant, size: resolvedSize }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
