import { create } from "zustand";
import type { AppSettings, ClipItem } from "./types";
import { DEFAULT_SETTINGS } from "./types";

interface AppState {
  items: ClipItem[];
  query: string;
  activeIndex: number;
  showSettings: boolean;
  settings: AppSettings;
  syncStatus: "idle" | "syncing" | "ok" | "err";
  syncMessage?: string;
  setItems: (items: ClipItem[]) => void;
  upsertItem: (item: ClipItem) => void;
  removeItem: (id: string) => void;
  togglePin: (id: string) => void;
  setQuery: (q: string) => void;
  setActiveIndex: (i: number) => void;
  setShowSettings: (b: boolean) => void;
  setSettings: (s: AppSettings) => void;
  setSyncStatus: (
    s: AppState["syncStatus"],
    message?: string
  ) => void;
}

export const useStore = create<AppState>((set) => ({
  items: [],
  query: "",
  activeIndex: 0,
  showSettings: false,
  settings: DEFAULT_SETTINGS,
  syncStatus: "idle",
  setItems: (items) => set({ items }),
  upsertItem: (item) =>
    set((s) => {
      const rest = s.items.filter((it) => it.id !== item.id);
      return { items: [item, ...rest] };
    }),
  removeItem: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  togglePin: (id) =>
    set((s) => ({
      items: s.items.map((it) =>
        it.id === id ? { ...it, pinned: !it.pinned } : it
      ),
    })),
  setQuery: (query) => set({ query, activeIndex: 0 }),
  setActiveIndex: (activeIndex) => set({ activeIndex }),
  setShowSettings: (showSettings) => set({ showSettings }),
  setSettings: (settings) => set({ settings }),
  setSyncStatus: (syncStatus, syncMessage) =>
    set({ syncStatus, syncMessage }),
}));
