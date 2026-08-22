import { useEffect } from 'react';
import { useChatStore } from './store/useChatStore';
import { installWipeListeners } from './services/WipeService';
import Landing from './screens/Landing';
import Waiting from './screens/Waiting';
import Chat from './screens/Chat';
import Unsupported from './screens/Unsupported';

function isRuntimeSupported(): boolean {
  return (
    typeof WebSocket !== 'undefined' &&
    typeof Promise !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  );
}

export default function App(): JSX.Element {
  const roomId = useChatStore((s) => s.roomId);
  const peerHasJoined = useChatStore((s) => s.peerHasJoined);

  useEffect(() => installWipeListeners(), []);

  if (!isRuntimeSupported()) return <Unsupported />;
  if (!roomId) return <Landing />;
  if (!peerHasJoined) return <Waiting />;
  return <Chat />;
}
