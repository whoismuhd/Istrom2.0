import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'istrom_theme';
const CHANGE_EVENT = 'istrom-theme-change';
let sessionPreference;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1521' : '#f6f7f9');
}

function preferredTheme() {
  if (sessionPreference) return sessionPreference;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Appearance still works when browser storage is unavailable. */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribe(onChange) {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const syncPreference = () => { applyTheme(preferredTheme()); onChange(); };
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      sessionPreference = undefined;
      syncPreference();
    }
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  system.addEventListener('change', syncPreference);
  // A preference can change in another tab before this control mounts.
  syncPreference();
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
    system.removeEventListener('change', syncPreference);
  };
}

const getSnapshot = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

export default function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'light');
  const toggleTheme = () => {
    const next = getSnapshot() === 'dark' ? 'light' : 'dark';
    sessionPreference = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the current session usable. */ }
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return { theme, toggleTheme };
}
