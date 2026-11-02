import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium', {
  variants: {
    tone: {
      default: 'border-transparent bg-brand-soft text-brand',
      outline: 'border-line bg-transparent text-ink-muted',
      muted: 'border-transparent bg-surface-muted text-ink-muted',
    },
  },
  defaultVariants: { tone: 'default' },
});

function Badge({ className, tone, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
