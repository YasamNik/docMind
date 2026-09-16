// Pattern: shadcn-style wrapper around a Radix-like primitive, following this repo's
// existing components/ui/*.tsx (dropdown-menu.tsx, select.tsx) that wrap @base-ui/react.
import * as React from "react";
import { Tabs } from "@base-ui/react/tabs";
import { cn } from "cn";

function TabsNav({ className, ...props }: React.ComponentProps<typeof Tabs.Root>) {
  return <Tabs.Root className={cn("flex flex-col gap-4", className)} {...props} />;
}

function TabsNavList({ className, ...props }: React.ComponentProps<typeof Tabs.List>) {
  return (
    <Tabs.List
      className={cn(
        "inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsNavTab({ className, ...props }: React.ComponentProps<typeof Tabs.Tab>) {
  return (
    <Tabs.Tab
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow",
        className,
      )}
      {...props}
    />
  );
}

function TabsNavPanel({ className, ...props }: React.ComponentProps<typeof Tabs.Panel>) {
  return (
    <Tabs.Panel
      className={cn("mt-2 ring-offset-background focus-visible:outline-none", className)}
      {...props}
    />
  );
}

export { TabsNav, TabsNavList, TabsNavTab, TabsNavPanel };
