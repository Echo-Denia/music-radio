import * as vscode from 'vscode';
import { Track, Lyrics, RepeatMode } from './types';
import { fetchRemoteState, sendRemoteCommand } from './audioServer';

export class RemotePlayerClient {
    private _onDidChange = new vscode.EventEmitter<string>();
    readonly onDidChange = this._onDidChange.event;

    private _currentTrack: Track | null = null;
    private _isPlaying = false;
    private _currentTime = 0;
    private _volume = 80;
    private _shuffle = false;
    private _repeat: RepeatMode = 'none';
    private _lyrics: Lyrics | null = null;
    private _hostPort: number;
    private _getPort: () => Promise<number | null>;
    private _pollTimer: ReturnType<typeof setInterval> | null = null;
    private _connected = true;

    constructor(hostPort: number, getPort?: () => Promise<number | null>) {
        this._hostPort = hostPort;
        this._getPort = getPort || (async () => hostPort);
        this.startPolling();
    }

    get getCurrentTrack(): Track | null { return this._currentTrack; }
    get GetIsPlaying(): boolean { return this._isPlaying; }
    get GetCurrentTime(): number { return this._currentTime; }
    get GetVolume(): number { return this._volume; }
    get GetShuffle(): boolean { return this._shuffle; }
    get GetRepeat(): RepeatMode { return this._repeat; }
    get GetLyrics(): Lyrics | null { return this._lyrics; }
    get IsConnected(): boolean { return this._connected; }

    private startPolling(): void {
        this.poll();
        this._pollTimer = setInterval(() => this.poll(), 1000);
    }

    private async poll(): Promise<void> {
        try {
            const state = await fetchRemoteState(this._hostPort);
            if (state.error) {
                const wasConnected = this._connected;
                this._connected = false;
                if (wasConnected) {
                    this._onDidChange.fire('stateChange');
                }
                return;
            }
            const wasConnected = this._connected;
            this._connected = true;

            const prevTrackId = this._currentTrack?.id;
            const prevPlaying = this._isPlaying;

            this._currentTrack = state.currentTrack || null;
            this._isPlaying = state.isPlaying || false;
            this._currentTime = state.currentTime || 0;
            this._volume = state.volume || 80;
            this._shuffle = state.shuffle || false;
            this._repeat = state.repeat || 'none';
            this._lyrics = state.lyrics || null;

            if (!wasConnected) {
                this._onDidChange.fire('trackChange');
            } else if (prevTrackId !== this._currentTrack?.id) {
                this._onDidChange.fire('trackChange');
            } else if (prevPlaying !== this._isPlaying) {
                this._onDidChange.fire('stateChange');
            }
            this._onDidChange.fire('timeUpdate');
        } catch {
            const wasConnected = this._connected;
            this._connected = false;
            if (wasConnected) {
                this._onDidChange.fire('stateChange');
            }
            try {
                const newPort = await this._getPort();
                if (newPort !== null && newPort !== this._hostPort) {
                    this._hostPort = newPort;
                }
            } catch { /* ignore */ }
        }
    }

    async togglePlayPause(): Promise<void> {
        try { await sendRemoteCommand(this._hostPort, 'playPause'); } catch { /* ignore */ }
    }

    async next(): Promise<void> {
        try { await sendRemoteCommand(this._hostPort, 'next'); } catch { /* ignore */ }
    }

    async previous(): Promise<void> {
        try { await sendRemoteCommand(this._hostPort, 'previous'); } catch { /* ignore */ }
    }

    async toggleShuffle(): Promise<void> {
        try { await sendRemoteCommand(this._hostPort, 'toggleShuffle'); } catch { /* ignore */ }
    }

    async toggleRepeat(): Promise<void> {
        try { await sendRemoteCommand(this._hostPort, 'toggleRepeat'); } catch { /* ignore */ }
    }

    dispose(): void {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this._onDidChange.dispose();
    }
}