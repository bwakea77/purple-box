import { useEffect, useState } from 'react';
import * as SocketService from '../services/SocketService';

function roomIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/r\/([^/]+)/);
  return match?.[1] ?? null;
}

export default function Landing(): JSX.Element {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [nickname, setNickname] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fromUrl = roomIdFromUrl();
    if (fromUrl) {
      setJoinCode(fromUrl);
      setMode('join');
    }
  }, []);

  async function handleCreate(): Promise<void> {
    if (!nickname.trim()) {
      setError('Pick a nickname first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const roomId = await SocketService.createRoom(nickname.trim());
      window.history.pushState({}, '', `/r/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a room.');
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(): Promise<void> {
    if (!nickname.trim()) {
      setError('Pick a nickname first.');
      return;
    }
    const code = joinCode.trim();
    if (!code) {
      setError('Paste a room link or code.');
      return;
    }
    const roomId = code.includes('/r/') ? code.split('/r/')[1]! : code;
    setBusy(true);
    setError(null);
    try {
      await SocketService.joinRoom(roomId, nickname.trim());
      window.history.pushState({}, '', `/r/${roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that room.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="brand">Purple Box</div>
      <p className="hint-text">A private room for two. Nothing is saved — when you leave, it's gone.</p>

      <div className="card">
        <input
          className="text-input"
          placeholder="Your nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={40}
        />

        {mode === 'choose' && (
          <>
            <button className="btn" onClick={() => setMode('create')} disabled={busy}>
              Start a new chat
            </button>
            <button className="btn btn-secondary" onClick={() => setMode('join')} disabled={busy}>
              Join with a link
            </button>
          </>
        )}

        {mode === 'create' && (
          <button className="btn" onClick={() => void handleCreate()} disabled={busy}>
            {busy ? 'Creating…' : 'Create room'}
          </button>
        )}

        {mode === 'join' && (
          <>
            <input
              className="text-input"
              placeholder="Room link or code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button className="btn" onClick={() => void handleJoin()} disabled={busy}>
              {busy ? 'Joining…' : 'Join room'}
            </button>
          </>
        )}

        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
