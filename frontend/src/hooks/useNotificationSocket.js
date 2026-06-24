import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const WS_RECONNECT_BASE_MS = 1500;
const WS_RECONNECT_MAX_MS = 15000;
const WS_PING_INTERVAL_MS = 25000;
const SOUND_THROTTLE_MS = 2000;

function buildNotificationSocketUrl(token) {
  const apiBase = import.meta.env.VITE_API_URL || '/api';
  const resolvedBase = apiBase.startsWith('http://') || apiBase.startsWith('https://')
    ? new URL(apiBase)
    : new URL(apiBase, window.location.origin);

  const wsProtocol = resolvedBase.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = resolvedBase.pathname === '/' ? '' : resolvedBase.pathname.replace(/\/$/, '');
  const wsPath = `${basePath}/ws/notifications`;

  return `${wsProtocol}//${resolvedBase.host}${wsPath}?token=${encodeURIComponent(token)}`;
}

function shouldRefreshForEvent(type) {
  return (
    type === 'notification_created'
    || type === 'notification_updated'
    || type === 'notification_deleted'
    || type === 'notifications_cleared'
  );
}

function createOrGetAudioContext(existingContext) {
  if (existingContext) return existingContext;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  return new Ctx();
}

async function playNotificationChime(audioContext) {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const now = audioContext.currentTime;
  const master = audioContext.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.14, now + 0.03);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  master.connect(audioContext.destination);

  const osc1 = audioContext.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(880, now);
  osc1.connect(master);
  osc1.start(now);
  osc1.stop(now + 0.16);

  const osc2 = audioContext.createOscillator();
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(1174.66, now + 0.16);
  osc2.connect(master);
  osc2.start(now + 0.16);
  osc2.stop(now + 0.42);
}

export default function useNotificationSocket() {
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(() => false);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const pingTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const audioContextRef = useRef(null);
  const lastSoundAtRef = useRef(0);
  const hasAudioInteractionRef = useRef(false);

  useEffect(() => {
    const token = localStorage.getItem('istrom_token');
    if (!token) {
      return undefined;
    }

    let closedByClient = false;

    const clearTimers = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };

    const unlockAudio = async () => {
      try {
        const context = createOrGetAudioContext(audioContextRef.current);
        if (!context) return;
        audioContextRef.current = context;
        if (context.state === 'suspended') {
          await context.resume();
        }
        hasAudioInteractionRef.current = true;
      } catch {
        // Ignore unlock failures; browser gesture policy can block until a later interaction.
      }
    };

    const maybePlayAlertSound = async (eventType) => {
      if (eventType !== 'notification_created') return;
      if (!hasAudioInteractionRef.current) return;
      const nowMs = Date.now();
      if (nowMs - lastSoundAtRef.current < SOUND_THROTTLE_MS) return;

      try {
        const context = createOrGetAudioContext(audioContextRef.current);
        if (!context) return;
        audioContextRef.current = context;
        await playNotificationChime(context);
        lastSoundAtRef.current = nowMs;
      } catch {
        // Ignore audio playback failures and keep notifications functional.
      }
    };

    const invalidateNotificationQueries = () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'notifications'] });
    };

    const scheduleReconnect = () => {
      if (closedByClient) return;
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(WS_RECONNECT_BASE_MS * (2 ** attempt), WS_RECONNECT_MAX_MS);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    const connect = () => {
      clearTimers();

      try {
        const socketUrl = buildNotificationSocketUrl(token);
        const ws = new WebSocket(socketUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;
          setIsLive(true);
          pingTimerRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send('ping');
            }
          }, WS_PING_INTERVAL_MS);
        };

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            maybePlayAlertSound(payload?.type);
            if (shouldRefreshForEvent(payload?.type)) {
              invalidateNotificationQueries();
            }
          } catch {
            // Ignore malformed payloads.
          }
        };

        ws.onerror = () => {
          ws.close();
        };

        ws.onclose = () => {
          setIsLive(false);
          clearTimers();
          scheduleReconnect();
        };
      } catch {
        setIsLive(false);
        scheduleReconnect();
      }
    };

    connect();

    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    return () => {
      closedByClient = true;
      clearTimers();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'client_shutdown');
      }
    };
  }, [queryClient]);

  return { isLive };
}
