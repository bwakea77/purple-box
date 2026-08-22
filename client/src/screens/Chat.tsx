import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/useChatStore';
import * as SocketService from '../services/SocketService';
import * as Crypto from '../services/CryptoService';
import { wipeImmediately } from '../services/WipeService';

function PresenceBadge(): JSX.Element {
  const peerPresence = useChatStore((s) => s.peerPresence);
  const reconnectDeadline = useChatStore((s) => s.reconnectDeadline);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (peerPresence !== 'PEER_RECONNECTING') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [peerPresence]);

  if (peerPresence === 'PEER_LEFT') {
    return <span className="presence-badge left">They left</span>;
  }
  if (peerPresence === 'PEER_RECONNECTING') {
    const secondsLeft = Math.max(0, Math.ceil(((reconnectDeadline ?? now) - now) / 1000));
    return (
      <span className="presence-badge reconnecting">
        Reconnecting… <span className="reconnect-countdown">{secondsLeft}s</span>
      </span>
    );
  }
  return <span className="presence-badge in-chat">Online</span>;
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'pending':
      return '⏳';
    case 'sent':
      return '✓';
    case 'delivered':
      return '✓✓';
    default:
      return '';
  }
}

export default function Chat(): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const peerNickname = useChatStore((s) => s.peerNickname);
  const peerPresence = useChatStore((s) => s.peerPresence);
  const connectionLost = useChatStore((s) => s.connectionLost);
  const [draft, setDraft] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const composerDisabled = peerPresence === 'PEER_LEFT' || connectionLost;

  function handleSend(): void {
    const text = draft.trim();
    if (!text) return;
    if (!Crypto.fitsWithinCiphertextLimit(text)) {
      setWarning(`Message too long — keep it under ${Crypto.MAX_PLAINTEXT_BYTES} bytes.`);
      return;
    }
    setWarning(null);
    setDraft('');
    void SocketService.sendMessage(text);
  }

  function handleLeave(): void {
    SocketService.leaveChat();
    wipeImmediately();
  }

  return (
    <div className="chat-screen">
      <div className="chat-header">
        <div>
          <div className="peer-name">{peerNickname ?? 'Peer'}</div>
        </div>
        <PresenceBadge />
        <button className="btn btn-secondary" onClick={handleLeave} style={{ minHeight: 36, padding: '6px 12px' }}>
          Leave
        </button>
      </div>

      {connectionLost && (
        <p className="error-text" style={{ padding: '8px 16px', margin: 0 }}>
          Connection lost. This room is now closed.
        </p>
      )}

      <div className="message-list" ref={listRef}>
        <p className="hint-text">Screenshots can't be prevented. Only share what you'd accept being kept.</p>
        {messages.map((m) => (
          <div key={m.messageId} className={`bubble-row ${m.sender}`}>
            <div className={`bubble ${m.sender}`}>
              {m.text}
              {m.sender === 'me' && (
                <span className={`message-meta ${m.status === 'failed' ? 'failed' : ''}`}>
                  {m.status === 'failed' ? 'Failed to send' : statusGlyph(m.status)}
                  {m.status === 'failed' && (
                    <button className="retry-btn" onClick={() => SocketService.retryMessage(m.messageId)}>
                      Retry
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {warning && <p className="error-text" style={{ padding: '0 16px' }}>{warning}</p>}

      <div className="composer">
        <input
          className="text-input"
          placeholder={
            peerPresence === 'PEER_LEFT' ? 'This room is closed' : 'Type a message'
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend();
          }}
          disabled={composerDisabled}
        />
        <button className="btn" onClick={handleSend} disabled={composerDisabled || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
