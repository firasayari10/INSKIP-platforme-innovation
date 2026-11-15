import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border text-ui font-normal disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground font-semibold hover:bg-primary-hover hover:border-primary-hover",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground font-semibold hover:bg-[#9a1e14]",
        outline: "border-input bg-background text-foreground hover:bg-accent",
        secondary: "border-border bg-muted text-foreground hover:bg-accent",
        ghost: "border-transparent bg-transparent hover:bg-accent",
        link: "h-auto border-transparent px-0 text-primary underline underline-offset-2 hover:no-underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2",
        lg: "h-9 px-4 text-sm",
        icon: "size-8",
      },
    },
    // Un lien garde sa hauteur et son retrait naturels, quelle que soit la taille demandée
    // (24 px de cible minimale, WCAG 2.5.8).
    compoundVariants: [{ variant: "link", class: "h-auto min-h-6 px-0" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
