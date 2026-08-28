import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { PlayerManager } from './playerManager';

const ALLOWED_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.opus']);

let server: http.Server | null = null;
let serverPort = 0;
const tokenMap = new Map<string, string>();
let playerManager: PlayerManager | null = null;

function getPortFilePath(): string {
    return path.join(os.tmpdir(), 'music-radio-port');
}

function writePortFile(port: number): void {
    try {
        fs.writeFileSync(getPortFilePath(), String(port), 'utf8');
    } catch { /* ignore */ }
}

function readPortFile(): number | null {
    try {
        const content = fs.readFileSync(getPortFilePath(), 'utf8').trim();
        const port = parseInt(content, 10);
        return isNaN(port) ? null : port;
    } catch {
        return null;
    }
}

function removePortFile(): void {
    try {
        fs.unlinkSync(getPortFilePath());
    } catch { /* ignore */ }
}

export function registerPlayerManager(pm: PlayerManager): void {
    playerManager = pm;
}

export function getServerPort(): number {
    return serverPort;
}

export async function getHostPort(): Promise<number | null> {
    const port = readPortFile();
    if (!port) { return null; }
    try {
        const ok = await new Promise<boolean>((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
                resolve(res.statusCode === 200);
                res.resume();
            });
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => { req.destroy(); resolve(false); });
        });
        return ok ? port : null;
    } catch {
        return null;
    }
}

export function startServer(): Promise<number> {
    return new Promise((resolve, reject) => {
        if (server) {
            resolve(serverPort);
            return;
        }

        server = http.createServer((req, res) => {
            try {
                if (!req.url) {
                    res.writeHead(400);
                    res.end();
                    return;
                }

                const url = new URL(req.url, `http://localhost:${serverPort}`);

                if (req.method === 'OPTIONS') {
                    res.writeHead(204, {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Range, Content-Type',
                        'Access-Control-Max-Age': '86400',
                    });
                    res.end();
                    return;
                }

                if (url.pathname === '/api/ping') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    return;
                }

                if (url.pathname === '/api/state') {
                    handleStateRequest(res);
                    return;
                }

                if (url.pathname === '/api/command' && req.method === 'POST') {
                    handleCommandRequest(req, res);
                    return;
                }

                const token = url.searchParams.get('token');
                const filePath = tokenMap.get(token || '');

                if (!filePath || !fs.existsSync(filePath)) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }

                const ext = path.extname(filePath).toLowerCase();
                if (!ALLOWED_EXTENSIONS.has(ext)) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }

                const stat = fs.statSync(filePath);
                const range = req.headers.range;

                let contentType = 'audio/mpeg';
                if (ext === '.flac') { contentType = 'audio/flac'; }
                else if (ext === '.wav') { contentType = 'audio/wav'; }
                else if (ext === '.ogg') { contentType = 'audio/ogg'; }
                else if (ext === '.m4a') { contentType = 'audio/mp4'; }
                else if (ext === '.aac') { contentType = 'audio/aac'; }
                else if (ext === '.wma') { contentType = 'audio/x-ms-wma'; }
                else if (ext === '.opus') { contentType = 'audio/opus'; }

                if (range) {
                    const parts = range.replace(/bytes=/, '').split('-');
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                    const chunkSize = end - start + 1;

                    res.writeHead(206, {
                        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunkSize,
                        'Content-Type': contentType,
                        'Cache-Control': 'no-cache',
                        'Access-Control-Allow-Origin': '*',
                    });

                    const stream = fs.createReadStream(filePath, { start, end });
                    stream.pipe(res);
                } else {
                    res.writeHead(200, {
                        'Content-Length': stat.size,
                        'Content-Type': contentType,
                        'Accept-Ranges': 'bytes',
                        'Cache-Control': 'no-cache',
                        'Access-Control-Allow-Origin': '*',
                    });

                    const stream = fs.createReadStream(filePath);
                    stream.pipe(res);
                }
            } catch {
                res.writeHead(500);
                res.end('Internal error');
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            if (typeof addr === 'object' && addr) {
                serverPort = addr.port;
                writePortFile(serverPort);
            }
            resolve(serverPort);
        });

        server.on('error', (err) => {
            reject(err);
        });
    });
}

function handleStateRequest(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    if (!playerManager) {
        res.end(JSON.stringify({ error: 'no player' }));
        return;
    }
    const state = playerManager.getState();
    state.currentTime = playerManager.getEstimatedCurrentTime();
    res.end(JSON.stringify(state));
}

function handleCommandRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer | string) => { body += chunk; });
    req.on('end', () => {
        try {
            const msg = JSON.parse(body);
            if (!playerManager) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'no player' }));
                return;
            }
            switch (msg.command) {
                case 'playPause':
                    playerManager.togglePlayPause();
                    break;
                case 'next':
                    playerManager.next();
                    break;
                case 'previous':
                    playerManager.previous();
                    break;
                case 'seek':
                    if (typeof msg.time === 'number') {
                        playerManager.seekTo(msg.time);
                    }
                    break;
                case 'setVolume':
                    if (typeof msg.volume === 'number') {
                        playerManager.setVolume(msg.volume);
                    }
                    break;
                case 'toggleShuffle':
                    playerManager.toggleShuffle();
                    break;
                case 'toggleRepeat':
                    playerManager.toggleRepeat();
                    break;
                default:
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'unknown command' }));
                    return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'invalid json' }));
        }
    });
}

export function stopServer(): Promise<void> {
    return new Promise((resolve) => {
        if (server) {
            removePortFile();
            server.close(() => {
                server = null;
                serverPort = 0;
                tokenMap.clear();
                playerManager = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

export function createAudioUrl(filePath: string): string {
    const token = crypto.randomBytes(16).toString('hex');
    tokenMap.set(token, filePath);
    return `http://127.0.0.1:${serverPort}/audio?token=${token}`;
}

export function cleanupTokens(): void {
    if (tokenMap.size > 1000) {
        tokenMap.clear();
    }
}

export function sendRemoteCommand(port: number, command: string, params?: Record<string, any>): Promise<void> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ command, ...params });
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/command',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            res.resume();
            if (res.statusCode === 200) {
                resolve();
            } else {
                reject(new Error(`Command failed: ${res.statusCode}`));
            }
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

export function fetchRemoteState(port: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/state`, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer | string) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}