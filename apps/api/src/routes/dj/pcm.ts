import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

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

    const send = (message: Record<string, string | number>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(authTimer);
      if (currentBroadcaster === socket) currentBroadcaster = null;
      if (encoder) {
        encoder.stdin.destroy();
        encoder.kill('SIGTERM');
        encoder = null;
      }
    };
    const fail = (message: string) => {
      send({ type: 'error', message });
      socket.close(1011, 'Broadcast unavailable');
      cleanup();
    };

    const authTimer = setTimeout(() => {
      if (!authorized) socket.close(1008, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    socket.on('message', (data, isBinary) => {
      if (stopped) return;
      if (!authorized) {
        if (isBinary) {
          socket.close(1008, 'Authenticate first');
          return;
        }
        let message: { type?: string; token?: string };
        try {
          message = JSON.parse(data.toString()) as typeof message;
        } catch {
          socket.close(1008, 'Invalid authentication');
          return;
        }
        if (message.type !== 'auth' || !isValidToken(message.token ?? '')) {
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
        ], { stdio: ['pipe', 'ignore', 'pipe'] });

        encoder.on('error', () => fail('Station encoder could not be started.'));
        encoder.on('exit', (code) => {
          if (!stopped) fail('Station encoder stopped (' + String(code ?? 'unknown') + '). Check if an external DJ already owns the stream.');
        });
        // Read stderr so the child cannot block. Never log raw stderr because
        // ffmpeg may echo the source-password URL in error messages.
        encoder.stderr.on('data', () => undefined);
        send({ type: 'ready', message: 'Secure connection established; sending stereo audio to the station.' });
        return;
      }

      if (!isBinary || !Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_FRAME_BYTES || data.length % 4 !== 0) {
        fail('Unexpected audio frame.');
        return;
      }
      if (!encoder || !encoder.stdin.writable || encoder.stdin.writableLength > MAX_PENDING_BYTES) {
        fail('Audio uplink is too slow. Stop playback and reconnect on a stronger network.');
        return;
      }
      encoder.stdin.write(data);
      bytesReceived += data.length;
      if (Date.now() - lastFeedback >= 5000) {
        send({ type: 'stats', bytesReceived });
        lastFeedback = Date.now();
      }
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
};

export default djIngestRoute;
