import { useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import * as SocketService from '../services/SocketService';
import { wipeImmediately } from '../services/WipeService';

export default function Waiting(): JSX.Element {
  const roomId = useChatStore((s) => s.roomId);
  const lastError = useChatStore((s) => s.lastError);
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}/r/${roomId ?? ''}`;
  const roomClosed = !!lastError;

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable — the link box itself is still selectable
    }
  }

  function startOver(): void {
    SocketService.leaveChat();
    wipeImmediately();
  }

  if (roomClosed) {
    return (
      <div className="screen">
        <div className="brand">Purple Box</div>
        <h1>No one joined</h1>
        <p className="hint-text">This room has closed. Nobody arrived in time.</p>
        <button className="btn" onClick={startOver}>
          Start a new chat
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="brand">Purple Box</div>
      <h1>Waiting for them to join…</h1>
      <div className="card">
        <div className="link-box">{shareUrl}</div>
        <button className="btn" onClick={() => void copyLink()}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        <p className="hint-text">Send this link to the other person. This room expires after 10 minutes if no one joins.</p>
        <button className="btn btn-secondary" onClick={startOver}>
          Cancel
        </button>
      </div>
    </div>
  );
}
