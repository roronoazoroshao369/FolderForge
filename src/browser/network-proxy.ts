import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as connectTcp, type Socket } from 'node:net';
import { Transform, type Duplex, type TransformCallback } from 'node:stream';

export interface NetworkShape {
  offline?: boolean;
  latencyMs?: number;
  downloadBytesPerSecond?: number;
  uploadBytesPerSecond?: number;
}

export interface NetworkProxyStatus {
  running: boolean;
  host: '127.0.0.1';
  port?: number;
  url?: string;
  shape: Required<NetworkShape>;
  requests: number;
  connects: number;
  rejected: number;
  bytesUp: number;
  bytesDown: number;
}

const MAX_LATENCY = 60_000;
const MAX_BANDWIDTH = 1024 * 1024 * 1024;

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

export function normalizeNetworkShape(shape: NetworkShape = {}): Required<NetworkShape> {
  return {
    offline: shape.offline === true,
    latencyMs: boundedInteger(shape.latencyMs ?? 0, 'latencyMs', 0, MAX_LATENCY),
    downloadBytesPerSecond: boundedInteger(
      shape.downloadBytesPerSecond ?? 0,
      'downloadBytesPerSecond',
      0,
      MAX_BANDWIDTH,
    ),
    uploadBytesPerSecond: boundedInteger(
      shape.uploadBytesPerSecond ?? 0,
      'uploadBytesPerSecond',
      0,
      MAX_BANDWIDTH,
    ),
  };
}

class BandwidthTransform extends Transform {
  private nextAt = Date.now();

  constructor(
    private readonly bytesPerSecond: number,
    private readonly onBytes: (count: number) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.onBytes(buffer.byteLength);
    if (this.bytesPerSecond <= 0) {
      callback(null, buffer);
      return;
    }
    const now = Date.now();
    const startAt = Math.max(now, this.nextAt);
    const duration = Math.ceil((buffer.byteLength / this.bytesPerSecond) * 1000);
    this.nextAt = startAt + duration;
    const delay = Math.max(0, startAt - now);
    const timer = setTimeout(() => callback(null, buffer), delay);
    timer.unref();
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref();
  });
}

function rejectProxy(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(message, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export class ShapingProxy {
  private server: ReturnType<typeof createHttpServer> | null = null;
  private sockets = new Set<Socket>();
  private shape = normalizeNetworkShape();
  private counters = { requests: 0, connects: 0, rejected: 0, bytesUp: 0, bytesDown: 0 };

  async start(shape: NetworkShape = {}): Promise<NetworkProxyStatus> {
    this.shape = normalizeNetworkShape(shape);
    if (this.server) return this.status();
    const server = createHttpServer((req, res) => void this.handleRequest(req, res));
    server.on('connect', (req, socket, head) => void this.handleConnect(req, socket, head));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    this.server = server;
    return this.status();
  }

  configure(shape: NetworkShape): NetworkProxyStatus {
    this.shape = normalizeNetworkShape(shape);
    return this.status();
  }

  status(): NetworkProxyStatus {
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : undefined;
    return {
      running: Boolean(this.server),
      host: '127.0.0.1',
      ...(port !== undefined ? { port, url: `http://127.0.0.1:${port}` } : {}),
      shape: { ...this.shape },
      ...this.counters,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.counters.requests += 1;
    if (this.shape.offline) {
      this.counters.rejected += 1;
      rejectProxy(res, 503, 'FolderForge network emulation: offline');
      return;
    }
    await delay(this.shape.latencyMs);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported proxy protocol.');
    } catch {
      this.counters.rejected += 1;
      rejectProxy(res, 400, 'FolderForge proxy requires an absolute HTTP URL.');
      return;
    }
    const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    headers.host = target.host;
    for (const header of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
      delete headers[header];
    }
    const upstream = requestFn(target, {
      method: req.method,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes
        .pipe(new BandwidthTransform(this.shape.downloadBytesPerSecond, (count) => { this.counters.bytesDown += count; }))
        .pipe(res);
    });
    upstream.once('error', (error) => {
      if (!res.headersSent) rejectProxy(res, 502, `FolderForge proxy upstream error: ${error.message}`);
      else res.destroy(error);
    });
    req.pipe(new BandwidthTransform(this.shape.uploadBytesPerSecond, (count) => { this.counters.bytesUp += count; })).pipe(upstream);
  }

  private async handleConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    this.counters.connects += 1;
    if (this.shape.offline) {
      this.counters.rejected += 1;
      client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    await delay(this.shape.latencyMs);
    const authority = String(req.url ?? '');
    let host = '';
    let port = 443;
    try {
      const parsed = new URL(`http://${authority}`);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : 443;
    } catch {
      // Rejected below.
    }
    if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      this.counters.rejected += 1;
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connectTcp(port, host);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: FolderForge\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client
        .pipe(new BandwidthTransform(this.shape.uploadBytesPerSecond, (count) => { this.counters.bytesUp += count; }))
        .pipe(upstream);
      upstream
        .pipe(new BandwidthTransform(this.shape.downloadBytesPerSecond, (count) => { this.counters.bytesDown += count; }))
        .pipe(client);
    });
    const fail = (): void => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    };
    upstream.once('error', fail);
    client.once('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  }
}
