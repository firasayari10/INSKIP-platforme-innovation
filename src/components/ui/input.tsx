import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-sm border border-input bg-background px-2 text-base md:text-ui placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring focus-visible:border-ring aria-invalid:border-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 file:border-0 file:bg-transparent file:text-ui",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
