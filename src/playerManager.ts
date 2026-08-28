import * as vscode from 'vscode';
import { Track, RepeatMode, Lyrics } from './types';
import { readMetadataAndLyrics } from './metadataReader';
import { scanDirectory } from './musicScanner';
import { createAudioUrl } from './audioServer';

type PlayerEventType = 'trackChange' | 'stateChange' | 'timeUpdate' | 'playlistChange' | 'lyricsUpdate' | 'seek' | 'volumeChange';

const metadataCache = new Map<string, { track: Track; lyrics: Lyrics | null; timestamp: number }>();
const CACHE_TTL = 30 * 60 * 1000;

const SHUFFLE_HISTORY_TTL = 4000;

interface ShuffleHistoryEntry {
    trackIndex: number;
    timestamp: number;
}

interface SavedPlaybackState {
    filePath: string;
    currentTime: number;
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    timestamp: number;
}

export class PlayerManager {
    private _onDidChange = new vscode.EventEmitter<string>();
    readonly onDidChange = this._onDidChange.event;

    private currentTrack: Track | null = null;
    private isPlaying = false;
    private currentTime = 0;
    private volume = 80;
    private shuffle = false;
    private repeat: RepeatMode = 'none';
    private playlist: Track[] = [];
    private queue: Track[] = [];
    private history: Track[] = [];
    private currentTrackIndex = -1;
    private lyrics: Lyrics | null = null;
    private musicFolders: string[] = [];
    private supportedFormats: string[];
    private audioUrl: string = '';
    private _trackEndTimer: ReturnType<typeof setInterval> | null = null;
    private _lastTimeUpdateTime = 0;
    private _lastWebviewTimeUpdate = 0;
    private _isBackgroundPaused = false;
    private context: vscode.ExtensionContext;
    private _saveTimer: ReturnType<typeof setInterval> | null = null;
    private _volumeSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private shuffleHistory: ShuffleHistoryEntry[] = [];
    private _processingTrackEnd = false;
    private _serverPlayStartTime = 0;
    private _serverPlayStartOffset = 0;
    private _lastWebviewReportedTime = 0;
    private _webviewTimeDrift = 0;
    private _trackEndCheckCount = 0;
    private _lastTrackEndCheckTime = 0;
    private _lastTrackEndTime = 0;
    private _trackGeneration = 0;
    private _actualDuration = 0;
    private _tunerState: any = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        const config = vscode.workspace.getConfiguration('music-radio');
        this.volume = config.get<number>('volume', 80);
        this.shuffle = config.get<boolean>('shuffle', false);
        this.repeat = config.get<RepeatMode>('repeat', 'none');
        this.supportedFormats = config.get<string[]>('supportedFormats', ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus']);
        this.musicFolders = config.get<string[]>('musicFolders', []);
        this._tunerState = context.globalState.get('tunerState', null);
        this._startSaveTimer();
    }

    get getCurrentTrack(): Track | null { return this.currentTrack; }
    get GetIsPlaying(): boolean { return this.isPlaying; }
    get GetCurrentTime(): number { return this.currentTime; }
    get GetVolume(): number { return this.volume; }
    get GetShuffle(): boolean { return this.shuffle; }
    get GetRepeat(): RepeatMode { return this.repeat; }
    get GetPlaylist(): Track[] { return [...this.playlist]; }
    get GetQueue(): Track[] { return [...this.queue]; }
    get GetHistory(): Track[] { return [...this.history]; }
    get GetLyrics(): Lyrics | null { return this.lyrics; }
    get GetMusicFolders(): string[] { return [...this.musicFolders]; }
    get GetCurrentTrackIndex(): number { return this.currentTrackIndex; }
    get GetAudioUrl(): string { return this.audioUrl; }

    async addMusicFolder(folderPath: string): Promise<void> {
        if (!this.musicFolders.includes(folderPath)) {
            this.musicFolders.push(folderPath);
            await vscode.workspace.getConfiguration('music-radio').update('musicFolders', this.musicFolders, true);
        }
        await this.scanAllFolders();
    }

    async removeMusicFolder(folderPath: string): Promise<void> {
        this.musicFolders = this.musicFolders.filter(f => f !== folderPath);
        await vscode.workspace.getConfiguration('music-radio').update('musicFolders', this.musicFolders, true);
        await this.scanAllFolders();
    }

    async reloadMusicFolder(folderPath: string): Promise<void> {
        if (!this.musicFolders.includes(folderPath)) {
            return;
        }

        for (const [key] of metadataCache) {
            if (key.startsWith(folderPath)) {
                metadataCache.delete(key);
            }
        }

        const otherTracks = this.playlist.filter(t => !t.filePath.startsWith(folderPath));
        const reloadedTracks = scanDirectory(folderPath, this.supportedFormats);

        this.playlist = [...otherTracks, ...reloadedTracks];

        if (this.currentTrack && !this.playlist.find(t => t.id === this.currentTrack!.id)) {
            const sameFile = this.playlist.find(t => t.filePath === this.currentTrack!.filePath);
            if (sameFile) {
                this.currentTrack = sameFile;
                this.currentTrackIndex = this.playlist.indexOf(sameFile);
            }
        } else if (this.currentTrack) {
            this.currentTrackIndex = this.playlist.findIndex(t => t.id === this.currentTrack!.id);
        }

        this._onDidChange.fire('playlistChange');

        this.loadMetadataInBackground(reloadedTracks);
    }

    async scanAllFolders(): Promise<void> {
        const allTracks: Track[] = [];
        for (const folder of this.musicFolders) {
            const tracks = scanDirectory(folder, this.supportedFormats);
            allTracks.push(...tracks);
        }

        this.playlist = allTracks;
        this._onDidChange.fire('playlistChange');

        this.loadMetadataInBackground(allTracks);
    }

    private async loadMetadataInBackground(tracks: Track[]): Promise<void> {
        const batchSize = 5;
        for (let i = 0; i < tracks.length; i += batchSize) {
            const batch = tracks.slice(i, i + batchSize);
            await Promise.all(batch.map(async (track, batchIdx) => {
                const globalIdx = i + batchIdx;
                try {
                    const result = await this.readMetadataWithCache(track);
                    if (this.playlist[globalIdx] && this.playlist[globalIdx].filePath === track.filePath) {
                        this.playlist[globalIdx] = result.track;
                    }
                } catch (e) {
                    console.error('Music Radio: background scan error for', track.filePath, e);
                }
            }));

            this._onDidChange.fire('playlistChange');

            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    }

    private async readMetadataWithCache(trackOrPath: Track | string): Promise<{ track: Track; lyrics: Lyrics | null }> {
        let filePath: string;
        let fallbackTrack: Track | undefined;

        if (typeof trackOrPath === 'string') {
            filePath = trackOrPath;
        } else {
            filePath = trackOrPath.filePath;
            fallbackTrack = trackOrPath;
        }

        const cached = metadataCache.get(filePath);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return { track: { ...cached.track }, lyrics: cached.lyrics };
        }

        const track: Track = fallbackTrack ? { ...fallbackTrack } : {
            id: `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            filePath,
            title: '',
            artist: 'Unknown',
            album: 'Unknown',
            duration: 0,
            fileName: '',
        };

        const result = await readMetadataAndLyrics(track);
        if (!result.track.title && result.track.fileName) {
            result.track.title = result.track.fileName;
        }
        metadataCache.set(filePath, { track: result.track, lyrics: result.lyrics, timestamp: Date.now() });
        return result;
    }

    async playTrack(track: Track): Promise<void> {
        if (this.currentTrack && this.currentTrack.id !== track.id) {
            this.history.unshift(this.currentTrack);
        }

        const qIdx = this.queue.findIndex(t => t.id === track.id);
        if (qIdx >= 0) {
            this.queue.splice(qIdx, 1);
        }

        this.audioUrl = createAudioUrl(track.filePath);

        try {
            const result = await this.readMetadataWithCache(track);
            track = result.track;
            this.lyrics = result.lyrics;

            const idx = this.playlist.findIndex(t => t.filePath === track.filePath);
            if (idx >= 0) {
                this.playlist[idx] = track;
            }
        } catch (e) {
            console.error('Music Radio: playTrack metadata error', e);
            this.lyrics = null;
        }

        this.currentTrack = track;
        this.isPlaying = true;
        this.currentTime = 0;
        this._lastTimeUpdateTime = Date.now();
        this._lastWebviewTimeUpdate = Date.now();
        this._isBackgroundPaused = false;
        this._serverPlayStartTime = Date.now();
        this._serverPlayStartOffset = 0;
        this._lastWebviewReportedTime = 0;
        this._webviewTimeDrift = 0;
        this._trackEndCheckCount = 0;
        this._lastTrackEndCheckTime = Date.now();
        this._trackGeneration++;
        this._lastTrackEndTime = 0;
        this._actualDuration = 0;

        const idx = this.playlist.findIndex(t => t.id === track.id);
        if (idx >= 0) {
            this.currentTrackIndex = idx;
        }

        this._startTrackEndTimer();

        this._onDidChange.fire('trackChange');
        this._onDidChange.fire('lyricsUpdate');
        this.savePlaybackState();
    }

    async playByIndex(index: number): Promise<void> {
        if (index >= 0 && index < this.playlist.length) {
            this.currentTrackIndex = index;
            await this.playTrack(this.playlist[index]);
        }
    }

    togglePlayPause(): void {
        if (!this.currentTrack && this.playlist.length > 0) {
            this.playTrack(this.playlist[0]);
            return;
        }
        this.isPlaying = !this.isPlaying;
        if (this.isPlaying) {
            this._serverPlayStartTime = Date.now();
            this._serverPlayStartOffset = this.currentTime;
            this._lastTimeUpdateTime = Date.now();
            this._startTrackEndTimer();
        } else {
            this.currentTime = this.getEstimatedCurrentTime();
            this._stopTrackEndTimer();
        }
        this._onDidChange.fire('stateChange');
    }

    pause(): void {
        if (this.isPlaying) {
            this.currentTime = this.getEstimatedCurrentTime();
        }
        this.isPlaying = false;
        this._stopTrackEndTimer();
        this._onDidChange.fire('stateChange');
    }

    resume(): void {
        if (!this.currentTrack && this.playlist.length > 0) {
            this.playTrack(this.playlist[0]);
            return;
        }
        this.isPlaying = true;
        this._serverPlayStartTime = Date.now();
        this._serverPlayStartOffset = this.currentTime;
        this._lastTimeUpdateTime = Date.now();
        this._lastWebviewTimeUpdate = Date.now();
        this._startTrackEndTimer();
        this._onDidChange.fire('stateChange');
    }

    setVolume(vol: number): void {
        this.volume = Math.max(0, Math.min(100, vol));
        this._onDidChange.fire('volumeChange');
        this._scheduleVolumeSave();
    }

    private _scheduleVolumeSave(): void {
        if (this._volumeSaveTimer) {
            clearTimeout(this._volumeSaveTimer);
        }
        this._volumeSaveTimer = setTimeout(() => {
            this._volumeSaveTimer = null;
            vscode.workspace.getConfiguration('music-radio').update('volume', this.volume, true);
        }, 500);
    }

    setCurrentTime(time: number): void {
        const duration = this.getEffectiveDuration();
        if (duration > 0 && time > duration + 2) {
            return;
        }
        const estimated = this.getEstimatedCurrentTime();
        const diff = Math.abs(time - estimated);
        if (diff < 3) {
            return;
        }
        this.currentTime = time;
        this._lastTimeUpdateTime = Date.now();
        this._lastWebviewTimeUpdate = Date.now();
        this._serverPlayStartTime = Date.now();
        this._serverPlayStartOffset = time;
        this._lastWebviewReportedTime = time;
        this._onDidChange.fire('timeUpdate');
    }

    seekTo(time: number): void {
        this.currentTime = time;
        this._lastTimeUpdateTime = Date.now();
        this._serverPlayStartTime = Date.now();
        this._serverPlayStartOffset = time;
        this._onDidChange.fire('seek');
        this.savePlaybackState();
    }

    toggleShuffle(): void {
        this.shuffle = !this.shuffle;
        vscode.workspace.getConfiguration('music-radio').update('shuffle', this.shuffle, true);
        this._onDidChange.fire('stateChange');
    }

    toggleRepeat(): void {
        const modes: RepeatMode[] = ['none', 'all', 'one'];
        const idx = modes.indexOf(this.repeat);
        this.repeat = modes[(idx + 1) % modes.length];
        vscode.workspace.getConfiguration('music-radio').update('repeat', this.repeat, true);
        this._onDidChange.fire('stateChange');
    }

    addToQueue(track: Track): void {
        this.queue = this.queue.filter(t => t.id !== track.id);
        this.queue.push(track);
        this._onDidChange.fire('playlistChange');
    }

    playNext(track: Track): void {
        this.queue = this.queue.filter(t => t.id !== track.id);
        this.queue.unshift(track);
        this._onDidChange.fire('playlistChange');
    }

    removeFromQueue(index: number): void {
        if (index >= 0 && index < this.queue.length) {
            this.queue.splice(index, 1);
            this._onDidChange.fire('playlistChange');
        }
    }

    removeFromHistory(index: number): void {
        if (index >= 0 && index < this.history.length) {
            this.history.splice(index, 1);
            this._onDidChange.fire('playlistChange');
        }
    }

    clearHistory(): void {
        this.history = [];
        this._onDidChange.fire('playlistChange');
    }

    removeFromPlaylist(index: number): void {
        if (index >= 0 && index < this.playlist.length) {
            this.playlist.splice(index, 1);
            if (this.currentTrackIndex > index) {
                this.currentTrackIndex--;
            }
            this._onDidChange.fire('playlistChange');
        }
    }

    clearPlaylist(): void {
        this.playlist = [];
        this.currentTrackIndex = -1;
        this._onDidChange.fire('playlistChange');
    }

    async next(): Promise<void> {
        if (this.queue.length > 0) {
            const nextTrack = this.queue.shift()!;
            await this.playTrack(nextTrack);
            return;
        }

        if (this.playlist.length === 0) {
            return;
        }

        if (this.currentTrackIndex >= 0 && this.currentTrackIndex < this.playlist.length) {
            this._pushToShuffleHistory(this.currentTrackIndex);
        }

        if (this.shuffle) {
            let nextIdx: number;
            do {
                nextIdx = Math.floor(Math.random() * this.playlist.length);
            } while (nextIdx === this.currentTrackIndex && this.playlist.length > 1);
            this.currentTrackIndex = nextIdx;
        } else {
            this.currentTrackIndex++;
            if (this.currentTrackIndex >= this.playlist.length) {
                if (this.repeat === 'all') {
                    this.currentTrackIndex = 0;
                } else {
                    this.currentTrackIndex = this.playlist.length - 1;
                    this.isPlaying = false;
                    this._onDidChange.fire('stateChange');
                    return;
                }
            }
        }

        await this.playTrack(this.playlist[this.currentTrackIndex]);
    }

    async previous(): Promise<void> {
        if (this.playlist.length === 0) {
            return;
        }

        if (this.currentTime > 3) {
            this.seekTo(0);
            return;
        }

        if (this.shuffle) {
            const historyEntry = this._popFromShuffleHistory();
            if (historyEntry !== null && historyEntry < this.playlist.length) {
                this.currentTrackIndex = historyEntry;
                await this.playTrack(this.playlist[this.currentTrackIndex]);
                return;
            }

            let prevIdx: number;
            do {
                prevIdx = Math.floor(Math.random() * this.playlist.length);
            } while (prevIdx === this.currentTrackIndex && this.playlist.length > 1);
            this.currentTrackIndex = prevIdx;
        } else {
            this.currentTrackIndex--;
            if (this.currentTrackIndex < 0) {
                this.currentTrackIndex = this.repeat === 'all' ? this.playlist.length - 1 : 0;
            }
        }

        await this.playTrack(this.playlist[this.currentTrackIndex]);
    }

    async onTrackEnd(fromWebview = false): Promise<void> {
        if (this._processingTrackEnd) {
            return;
        }
        const now = Date.now();
        if (this._lastTrackEndTime > 0 && now - this._lastTrackEndTime < 3000) {
            return;
        }
        if (fromWebview && this._trackGeneration > 0) {
            const serverElapsed = (now - this._serverPlayStartTime) / 1000;
            const serverEstimatedTime = this._serverPlayStartOffset + serverElapsed;
            const duration = this.getEffectiveDuration();
            if (duration > 0 && serverEstimatedTime < duration * 0.5 && serverEstimatedTime < 5) {
                return;
            }
        }
        this._processingTrackEnd = true;
        this._lastTrackEndTime = now;
        this._stopTrackEndTimer();
        try {
            if (this.repeat === 'one') {
                this.currentTime = 0;
                this.isPlaying = true;
                this._serverPlayStartTime = Date.now();
                this._serverPlayStartOffset = 0;
                this._lastTimeUpdateTime = Date.now();
                this._lastWebviewTimeUpdate = Date.now();
                this._startTrackEndTimer();
                this._onDidChange.fire('trackChange');
                this.savePlaybackState();
                return;
            }

            if (this.playlist.length === 0) {
                this.isPlaying = false;
                this._onDidChange.fire('stateChange');
                return;
            }

            await this.next();

            if (!this.isPlaying && this.repeat === 'all' && this.playlist.length > 0) {
                this.isPlaying = true;
                this._serverPlayStartTime = Date.now();
                this._serverPlayStartOffset = 0;
                this._lastTimeUpdateTime = Date.now();
                this._lastWebviewTimeUpdate = Date.now();
                this._startTrackEndTimer();
                this._onDidChange.fire('stateChange');
            }
        } finally {
            this._processingTrackEnd = false;
        }
    }

    getState() {
        return {
            currentTrack: this.currentTrack,
            isPlaying: this.isPlaying,
            currentTime: this.currentTime,
            duration: this.getEffectiveDuration(),
            volume: this.volume,
            shuffle: this.shuffle,
            repeat: this.repeat,
            playlist: this.playlist,
            queue: this.queue,
            history: this.history,
            currentTrackIndex: this.currentTrackIndex,
            audioUrl: this.audioUrl,
            lyrics: this.lyrics,
            musicFolders: this.musicFolders,
            serverTime: Date.now(),
            serverPlayStartTime: this._serverPlayStartTime,
            serverPlayStartOffset: this._serverPlayStartOffset,
            isBackgroundPaused: this._isBackgroundPaused,
            trackGeneration: this._trackGeneration,
            tunerState: this._tunerState,
        };
    }

    saveTunerState(tunerState: any): void {
        this._tunerState = tunerState;
        this.context.globalState.update('tunerState', tunerState);
    }

    loadTunerState(): any {
        if (!this._tunerState) {
            this._tunerState = this.context.globalState.get('tunerState', null);
        }
        return this._tunerState;
    }

    private _startTrackEndTimer(): void {
        this._stopTrackEndTimer();
        if (!this.currentTrack || !this.isPlaying) {
            return;
        }
        this._trackEndCheckCount = 0;
        this._lastTrackEndCheckTime = Date.now();
        this._trackEndTimer = setInterval(() => {
            if (!this.isPlaying || !this.currentTrack) {
                this._stopTrackEndTimer();
                return;
            }
            if (this._processingTrackEnd) {
                return;
            }

            const now = Date.now();
            const timeSinceLastCheck = now - this._lastTrackEndCheckTime;

            if (timeSinceLastCheck > 3000) {
                const duration = this.getEffectiveDuration();
                const rawElapsed = (now - this._serverPlayStartTime) / 1000;
                const rawEstimated = this._serverPlayStartOffset + rawElapsed;

                if (duration > 0 && rawEstimated >= duration + 0.5) {
                    this._serverPlayStartTime = now;
                    this._serverPlayStartOffset = Math.min(this.currentTime, duration - 0.5);
                } else {
                    this._serverPlayStartTime = now;
                    this._serverPlayStartOffset = Math.min(rawEstimated, duration > 0 ? duration - 0.5 : rawEstimated);
                }
            }
            this._lastTrackEndCheckTime = now;

            const serverElapsed = (now - this._serverPlayStartTime) / 1000;
            const serverEstimatedTime = this._serverPlayStartOffset + serverElapsed;
            const duration = this.getEffectiveDuration();

            if (duration > 0 && serverEstimatedTime >= duration + 0.5) {
                this._trackEndCheckCount++;
                if (this._trackEndCheckCount >= 2) {
                    this._stopTrackEndTimer();
                    this.onTrackEnd();
                    return;
                }
            } else {
                this._trackEndCheckCount = 0;
            }

            if (this._isBackgroundPaused) {
                return;
            }

            if (now - this._lastWebviewTimeUpdate > 2000) {
                this._onDidChange.fire('timeUpdate');
                this._lastWebviewTimeUpdate = now;
            }
        }, 500);
    }

    private _stopTrackEndTimer(): void {
        if (this._trackEndTimer) {
            clearInterval(this._trackEndTimer);
            this._trackEndTimer = null;
        }
    }

    private _pushToShuffleHistory(index: number): void {
        this._cleanExpiredShuffleHistory();
        this.shuffleHistory.push({ trackIndex: index, timestamp: Date.now() });
    }

    private _popFromShuffleHistory(): number | null {
        this._cleanExpiredShuffleHistory();
        if (this.shuffleHistory.length === 0) {
            return null;
        }
        const entry = this.shuffleHistory.pop()!;
        return entry.trackIndex;
    }

    private _cleanExpiredShuffleHistory(): void {
        const now = Date.now();
        this.shuffleHistory = this.shuffleHistory.filter(e => now - e.timestamp < SHUFFLE_HISTORY_TTL);
    }

    getEstimatedCurrentTime(): number {
        if (!this.isPlaying || !this.currentTrack) {
            return this.currentTime;
        }
        const serverElapsed = (Date.now() - this._serverPlayStartTime) / 1000;
        return this._serverPlayStartOffset + serverElapsed;
    }

    private getEffectiveDuration(): number {
        const meta = this.currentTrack?.duration || 0;
        const actual = this._actualDuration || 0;
        return Math.max(meta, actual);
    }

    updateActualDuration(duration: number): void {
        if (duration > 0 && Math.abs(duration - this._actualDuration) > 0.5) {
            this._actualDuration = duration;
        }
    }

    savePlaybackState(): void {
        if (!this.currentTrack) { return; }
        const estimatedTime = this.getEstimatedCurrentTime();
        const duration = this.getEffectiveDuration();
        const savedTime = duration > 0 ? Math.min(estimatedTime, duration - 0.5) : estimatedTime;
        const state: SavedPlaybackState = {
            filePath: this.currentTrack.filePath,
            currentTime: Math.max(0, savedTime),
            volume: this.volume,
            shuffle: this.shuffle,
            repeat: this.repeat,
            timestamp: Date.now(),
        };
        this.context.globalState.update('music-radio.playbackState', state);
    }

    async restorePlaybackState(): Promise<void> {
        const saved = this.context.globalState.get<SavedPlaybackState>('music-radio.playbackState');
        if (!saved || !saved.filePath) { return; }

        const track = this.playlist.find(t => t.filePath === saved.filePath);
        if (!track) { return; }

        this.audioUrl = createAudioUrl(track.filePath);

        try {
            const result = await this.readMetadataWithCache(track);
            const updatedTrack = result.track;
            this.lyrics = result.lyrics;

            const idx = this.playlist.findIndex(t => t.filePath === updatedTrack.filePath);
            if (idx >= 0) {
                this.playlist[idx] = updatedTrack;
            }

            this.currentTrack = updatedTrack;
        } catch (e) {
            this.currentTrack = track;
            this.lyrics = null;
        }

        this.isPlaying = false;
        this.currentTime = saved.currentTime;
        this._lastTimeUpdateTime = Date.now();
        this._serverPlayStartTime = Date.now();
        this._serverPlayStartOffset = saved.currentTime;

        const trackIdx = this.playlist.findIndex(t => t.filePath === this.currentTrack!.filePath);
        if (trackIdx >= 0) {
            this.currentTrackIndex = trackIdx;
        }

        this._onDidChange.fire('trackChange');
        this._onDidChange.fire('lyricsUpdate');
    }

    private _startSaveTimer(): void {
        this._stopSaveTimer();
        this._saveTimer = setInterval(() => {
            if (this.isPlaying && this.currentTrack) {
                this.savePlaybackState();
            }
        }, 30000);
    }

    private _stopSaveTimer(): void {
        if (this._saveTimer) {
            clearInterval(this._saveTimer);
            this._saveTimer = null;
        }
    }

    backgroundPause(): void {
        if (!this._isBackgroundPaused && this.isPlaying) {
            this.currentTime = this.getEstimatedCurrentTime();
        }
        this._isBackgroundPaused = true;
        this._stopTrackEndTimer();
    }

    backgroundResume(time?: number): void {
        if (this._isBackgroundPaused && this.isPlaying) {
            this._isBackgroundPaused = false;
            if (time !== undefined && time >= 0) {
                this.currentTime = time;
            }
            this._serverPlayStartTime = Date.now();
            this._serverPlayStartOffset = this.currentTime;
            this._lastTimeUpdateTime = Date.now();
            this._lastWebviewTimeUpdate = Date.now();
            this._startTrackEndTimer();
            this._onDidChange.fire('timeUpdate');
            this._onDidChange.fire('stateChange');
        }
    }

    wakeUp(): void {
        if (!this.isPlaying || !this.currentTrack) {
            return;
        }
        const duration = this.getEffectiveDuration();
        const rawElapsed = (Date.now() - this._serverPlayStartTime) / 1000;
        const rawEstimated = this._serverPlayStartOffset + rawElapsed;

        if (duration > 0 && rawEstimated >= duration + 0.5) {
            this.currentTime = Math.min(this.currentTime, duration - 0.5);
        } else {
            this.currentTime = Math.min(rawEstimated, duration > 0 ? duration - 0.5 : rawEstimated);
        }
        this.currentTime = Math.max(0, this.currentTime);

        this._isBackgroundPaused = false;
        this._serverPlayStartTime = Date.now();
        this._serverPlayStartOffset = this.currentTime;
        this._lastTimeUpdateTime = Date.now();
        this._lastWebviewTimeUpdate = Date.now();
        this._startTrackEndTimer();
        this._onDidChange.fire('timeUpdate');
    }

    get IsBackgroundPaused(): boolean {
        return this._isBackgroundPaused;
    }

    dispose(): void {
        if (this._volumeSaveTimer) {
            clearTimeout(this._volumeSaveTimer);
            this._volumeSaveTimer = null;
            vscode.workspace.getConfiguration('music-radio').update('volume', this.volume, true);
        }
        this.savePlaybackState();
        this._stopSaveTimer();
        this._stopTrackEndTimer();
    }
}