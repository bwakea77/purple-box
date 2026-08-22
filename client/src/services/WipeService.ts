import { useChatStore } from '../store/useChatStore';
import { disconnectSocket } from './SocketService';

// Layered wipe per room-client_spec.md § Wipe on leave: beforeunload alone is
// unreliable on mobile (iOS Safari frequently skips it; Android Chrome skips
// it when backgrounded then killed), so pagehide and a hidden-tab timer are
// required, not optional, fallbacks.
const HIDDEN_WIPE_MS = 5 * 60 * 1000;

let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

function wipeNow(): void {
  useChatStore.getState().wipeAndReset();
  disconnectSocket();
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!useChatStore.getState().roomId) return;
  wipeNow();
  e.preventDefault();
  e.returnValue = '';
}

function onPageHide(): void {
  if (!useChatStore.getState().roomId) return;
  wipeNow();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    if (!useChatStore.getState().roomId) return;
    hiddenTimer = setTimeout(wipeNow, HIDDEN_WIPE_MS);
  } else if (hiddenTimer) {
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
  }
}

export function installWipeListeners(): () => void {
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (hiddenTimer) clearTimeout(hiddenTimer);
  };
}

export function wipeImmediately(): void {
  wipeNow();
}
