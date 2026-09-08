import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Calendar, ChartColumn, Settings } from 'lucide-react';

import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';

const meta = {
  title: 'Shared/Components/Actions/Command',
  component: Command,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

function Items() {
  return (
    <CommandList>
      <CommandGroup>
        <CommandItem>
          <Calendar className="size-4" />
          Calendar
        </CommandItem>
        <CommandItem>
          <ChartColumn className="size-4" />
          Review
        </CommandItem>
        <CommandItem disabled>
          <Settings className="size-4" />
          Settings
        </CommandItem>
      </CommandGroup>
    </CommandList>
  );
}

export const Default: Story = {
  render: () => (
    <Command className="w-80">
      <CommandInput placeholder="Search" aria-label="Search" />
      <Items />
    </Command>
  ),
};

export const InDialog: Story = {
  render: () => (
    <CommandDialog open responsive="dialog" title="Search" description="Choose a destination">
      <CommandInput placeholder="Search" aria-label="Search" />
      <Items />
    </CommandDialog>
  ),
};

export const AllPatterns: Story = {
  render: () => (
    <Command className="w-80">
      <CommandInput placeholder="Search" aria-label="Search" />
      <Items />
      <CommandList>
        <CommandGroup>
          <CommandItem className="min-h-16 gap-3">
            <Calendar className="size-5" />
            <div className="min-w-0">
              <p className="truncate font-medium">Product planning</p>
              <p className="text-muted-foreground text-xs">September 8, 2026 · 09:00–10:00</p>
            </div>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};
