import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expireSession } from '../api';
import { useAuth } from '../contexts/useAuth';
import { workspaceGeneration } from '../utils/workspaceState';

const WS_RECONNECT_BASE_MS = 1500;
const WS_RECONNECT_MAX_MS = 15000;
const WS_PING_INTERVAL_MS = 25000;
const SOUND_THROTTLE_MS = 2000;

function buildNotificationSocketUrl() {
  const apiBase = import.meta.env.VITE_API_URL || '/api';
  const resolvedBase = apiBase.startsWith('http://') || apiBase.startsWith('https://')
    ? new URL(apiBase)
    : new URL(apiBase, window.location.origin);

  const wsProtocol = resolvedBase.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = resolvedBase.pathname === '/' ? '' : resolvedBase.pathname.replace(/\/$/, '');
  const wsPath = `${basePath}/ws/notifications`;

  return `${wsProtocol}//${resolvedBase.host}${wsPath}`;
}

function shouldRefreshForEvent(type) {
  return (
    type === 'notification_created'
    || type === 'notification_updated'
    || type === 'notification_deleted'
    || type === 'notifications_cleared'
    || type === 'workspace_updated'
  );
}

function createOrGetAudioContext(existingContext) {
  if (existingContext) return existingContext;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  return new Ctx();
}

async function playNotificationChime(audioContext, isCurrentSession) {
  if (!audioContext || !isCurrentSession()) return;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  if (!isCurrentSession()) return;

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
  const { user } = useAuth();
  const token = user ? sessionStorage.getItem('istrom_token') : null;
  const sessionGeneration = workspaceGeneration();
  const [liveSession, setLiveSession] = useState(null);
  const isLive = Boolean(token && liveSession?.token === token && liveSession.generation === sessionGeneration);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const pingTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const audioContextRef = useRef(null);
  const lastSoundAtRef = useRef(0);
  const hasAudioInteractionRef = useRef(false);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    let closedByClient = false;
    const isCurrentSession = () => !closedByClient
      && token === sessionStorage.getItem('istrom_token') && sessionGeneration === workspaceGeneration();

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
      if (!isCurrentSession()) return;
      try {
        const context = createOrGetAudioContext(audioContextRef.current);
        if (!context) return;
        audioContextRef.current = context;
        if (context.state === 'suspended') {
          await context.resume();
        }
        if (!isCurrentSession()) return;
        hasAudioInteractionRef.current = true;
      } catch {
        // Ignore unlock failures; browser gesture policy can block until a later interaction.
      }
    };

    const maybePlayAlertSound = async (eventType) => {
      if (!isCurrentSession()) return;
      if (eventType !== 'notification_created') return;
      if (!hasAudioInteractionRef.current) return;
      const nowMs = Date.now();
      if (nowMs - lastSoundAtRef.current < SOUND_THROTTLE_MS) return;

      try {
        const context = createOrGetAudioContext(audioContextRef.current);
        if (!context) return;
        audioContextRef.current = context;
        await playNotificationChime(context, isCurrentSession);
        if (!isCurrentSession()) return;
        lastSoundAtRef.current = nowMs;
      } catch {
        // Ignore audio playback failures and keep notifications functional.
      }
    };

    const invalidateNotificationQueries = () => {
      if (!isCurrentSession()) return;
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      for (const key of ['dashboard', 'items', 'requests', 'actuals', 'deletedRequests', 'projectSites', 'users', 'accessLogs']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    };

    const scheduleReconnect = () => {
      if (!isCurrentSession()) return;
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(WS_RECONNECT_BASE_MS * (2 ** attempt), WS_RECONNECT_MAX_MS);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    const connect = () => {
      if (!isCurrentSession()) return;
      clearTimers();

      try {
        const socketUrl = buildNotificationSocketUrl();
        const ws = new WebSocket(socketUrl);
        wsRef.current = ws;
        const isCurrentSocket = () => isCurrentSession() && wsRef.current === ws;

        ws.onopen = () => {
          if (!isCurrentSocket()) {
            ws.close(1000, 'client_shutdown');
            return;
          }
          ws.send(JSON.stringify({ type: 'authenticate', token }));
        };

        ws.onmessage = (event) => {
          if (!isCurrentSocket()) return;
          try {
            const payload = JSON.parse(event.data);
            if (payload?.type === 'connected') {
              reconnectAttemptRef.current = 0;
              setLiveSession({ token, generation: sessionGeneration });
              invalidateNotificationQueries();
              pingTimerRef.current = setInterval(() => {
                if (isCurrentSocket() && ws.readyState === WebSocket.OPEN) ws.send('ping');
              }, WS_PING_INTERVAL_MS);
            }
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

        ws.onclose = (event) => {
          if (!isCurrentSocket()) return;
          setLiveSession(null);
          clearTimers();
          if (event.code === 1008) {
            closedByClient = true;
            queryClient.clear();
            expireSession();
            return;
          }
          scheduleReconnect();
        };
      } catch {
        if (!isCurrentSession()) return;
        setLiveSession(null);
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
      if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) {
        ws.close(1000, 'client_shutdown');
      }
    };
  }, [queryClient, token, sessionGeneration]);

  useEffect(() => {
    if (isLive || !token) return undefined;
    const timer = setInterval(() => {
      if (token !== sessionStorage.getItem('istrom_token') || sessionGeneration !== workspaceGeneration()) return;
      for (const key of ['dashboard', 'items', 'requests', 'actuals', 'deletedRequests', 'projectSites', 'users', 'accessLogs']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [isLive, queryClient, token, sessionGeneration]);

  return { isLive };
}
