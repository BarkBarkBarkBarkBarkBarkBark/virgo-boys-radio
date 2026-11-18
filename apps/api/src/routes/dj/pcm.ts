import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { endDjMetrics, noteDjFrame, noteDjHeartbeat, startDjMetrics, verifyDjCredential } from '../../services/djOps.js';

// Browser audio is 48 kHz, stereo, 16-bit PCM sent as binary WebSocket frames.
// The server owns the Icecast source password; it is NEVER sent to the browser.
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
let currentBroadcaster: object | null = null;

function isValidToken(supplied: string): boolean {
  const configured = process.env.DJ_INGEST_TOKEN ?? '';
  if (!/^[0-9a-f]{64}$/i.test(configured) || !/^[0-9a-f]{64}$/i.test(supplied)) {
    return false;
  }
  const left = Buffer.from(configured.toLowerCase(), 'hex');
  const right = Buffer.from(supplied.toLowerCase(), 'hex');
  return timingSafeEqual(left, right);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  if (process.env.APP_ENV !== 'production') {
    allowed.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  return allowed.includes(origin);
}

const djIngestRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/dj/pcm', { websocket: true }, (socket, request) => {
    if (!isAllowedOrigin(request.headers.origin)) {
      socket.close(1008, 'Unauthorized origin');
      return;
    }

    let authorized = false;
    let encoder: ChildProcessWithoutNullStreams | null = null;
    let stopped = false;
    let bytesReceived = 0;
    let lastFeedback = Date.now();
    let sessionId: string | null = null;
    let disconnectReason = 'socket_disconnected';

    const send = (message: Record<string, string | number>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const cleanup = (reason = disconnectReason, closeCode?: number) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(authTimer);
      if (currentBroadcaster === socket) currentBroadcaster = null;
      if (sessionId) endDjMetrics(sessionId, reason, closeCode);
      if (encoder) {
        encoder.stdin.destroy();
        encoder.kill('SIGTERM');
        encoder = null;
      }
    };
    const fail = (message: string, reason = 'server_error') => {
      disconnectReason = reason;
      send({ type: 'error', message });
      socket.close(1011, 'Broadcast unavailable');
      cleanup(reason, 1011);
    };

    const authTimer = setTimeout(() => {
      if (!authorized) socket.close(1008, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (stopped) return;
      if (!authorized) {
        if (isBinary) {
          socket.close(1008, 'Authenticate first');
          return;
        }
        let message: { type?: string; token?: string; code?: string };
        try {
          message = JSON.parse(data.toString()) as typeof message;
        } catch {
          socket.close(1008, 'Invalid authentication');
          return;
        }
        const invite = verifyDjCredential({ token: message.token, code: message.code });
        const legacyAccepted = isValidToken(message.token ?? '');
        if (message.type !== 'auth' || (!invite && !legacyAccepted)) {
          socket.close(1008, 'Invalid invitation');
          return;
        }
        if (currentBroadcaster) {
          socket.close(1008, 'Another DJ is already connected');
          return;
        }
        const sourcePassword = process.env.ICECAST_SOURCE_PASSWORD;
        if (!sourcePassword || process.env.ICECAST_ENABLED !== 'true') {
          fail('Icecast is not enabled for broadcasting.');
          return;
        }

        authorized = true;
        clearTimeout(authTimer);
        currentBroadcaster = socket;
        // ffmpeg is installed into the server image. Never invoke a shell or
        // include the password in logs, browser code or command output.
        const output = 'icecast://source:' + encodeURIComponent(sourcePassword) + '@127.0.0.1:8000/radio.mp3';
        encoder = spawn('/usr/bin/ffmpeg', [
          '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
          '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000', '-ac', '2',
          '-content_type', 'audio/mpeg', '-f', 'mp3', '-method', 'PUT', output,
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        encoder.stdout.resume();
        sessionId = startDjMetrics(invite?.label ?? 'Legacy invited DJ', encoder.pid ?? null);

        encoder.on('error', () => fail('Station encoder could not be started.', 'ffmpeg_spawn_error'));
        encoder.on('exit', (code) => {
          if (!stopped) fail('Station encoder stopped (' + String(code ?? 'unknown') + '). Check if an external DJ already owns the stream.', 'ffmpeg_exit_' + String(code ?? 'unknown'));
        });
        // Read stderr so the child cannot block. Never log raw stderr because
        // ffmpeg may echo the source-password URL in error messages.
        encoder.stderr.on('data', () => undefined);
        send({ type: 'ready', message: 'Secure connection established; sending stereo audio to the station.' });
        return;
      }

      if (!isBinary) {
        try {
          const packet = JSON.parse(data.toString()) as { type?: string; clientTime?: number };
          if (packet.type === 'heartbeat') {
            if (sessionId) noteDjHeartbeat(sessionId);
            send({ type: 'heartbeat', serverTime: Date.now(), clientTime: Number(packet.clientTime) || 0 });
            return;
          }
        } catch { /* Malformed control frame. */ }
      }
      if (!isBinary || !Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_FRAME_BYTES || data.length % 4 !== 0) {
        fail('Unexpected audio frame.', 'invalid_audio_frame');
        return;
      }
      if (!encoder || !encoder.stdin.writable || encoder.stdin.writableLength > MAX_PENDING_BYTES) {
        fail('Audio uplink is too slow. Stop playback and reconnect on a stronger network.', 'encoder_backpressure');
        return;
      }
      encoder.stdin.write(data);
      bytesReceived += data.length;
      if (sessionId) noteDjFrame(sessionId, data.length, encoder.stdin.writableLength);
      if (Date.now() - lastFeedback >= 5000) {
        send({ type: 'stats', bytesReceived, pendingBytes: encoder.stdin.writableLength, serverTime: Date.now() });
        lastFeedback = Date.now();
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const safeReason = reason.toString().slice(0, 70).replace(/[^a-zA-Z0-9 _.-]/g, '');
      cleanup('websocket_close_' + code + (safeReason ? '_' + safeReason : ''), code);
    });
    socket.on('error', () => cleanup('websocket_error'));
  });
};

export default djIngestRoute;
