import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List className={cn('flex gap-2 border-b border-border', className)} {...props} />
  );
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'px-3 py-3 text-xs text-muted-foreground border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground focus-visible:outline-violet-400',
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('min-h-0 focus-visible:outline-none', className)}
      {...props}
    />
  );
}
