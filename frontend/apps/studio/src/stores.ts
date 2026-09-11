import { create } from "zustand";
export const useUiStore = create<{ collapsed: boolean; toggle: () => void }>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
export const useImportStore = create<{ step: number; setStep: (step: number) => void }>((set) => ({
  step: 0,
  setStep: (step) => set({ step }),
}));
