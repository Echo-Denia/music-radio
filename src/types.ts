export interface Track {
    id: string;
    filePath: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    albumArt?: string;
    fileName: string;
    format?: string;
    sampleRate?: number;
    bitDepth?: number;
    bitrate?: number;
    fileSize?: number;
    dateAdded?: number;
    dateModified?: number;
}

export interface LyricsLine {
    time: number;
    text: string;
    translation?: string;
}

export interface Lyrics {
    type: 'synced' | 'unsynced';
    lines: LyricsLine[];
    rawText?: string;
}

export type RepeatMode = 'none' | 'all' | 'one';

export interface PlayerState {
    currentTrack: Track | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    playlist: Track[];
    queue: Track[];
    history: Track[];
}

export interface MusicFolder {
    name: string;
    path: string;
}

export const SUPPORTED_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'mp4'];