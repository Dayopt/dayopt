'use client';

import { create } from 'zustand';

export interface ActivityDetailTarget {
  activityId: string;
  name: string;
  categoryName?: string | null;
  color?: string | null;
}

interface ActivityDetailState {
  isOpen: boolean;
  target: ActivityDetailTarget | null;
  open: (target: ActivityDetailTarget) => void;
  close: () => void;
}

/** Ephemeral selection shared by calendar actions and the shell's activity detail panel. */
export const useActivityDetailStore = create<ActivityDetailState>((set) => ({
  isOpen: false,
  target: null,
  open: (target) => set({ isOpen: true, target }),
  close: () => set({ isOpen: false, target: null }),
}));
