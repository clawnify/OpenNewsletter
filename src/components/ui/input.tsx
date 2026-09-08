import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-[0.5rem] border-0 bg-card px-2.5 py-1 text-base shadow-edge transition-[background-color,box-shadow] outline-none file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_var(--accent-tint)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)] md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
