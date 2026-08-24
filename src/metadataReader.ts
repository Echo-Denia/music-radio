import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import * as mm from 'music-metadata';
import { Track, Lyrics } from './types';
import { parseLrc, mergeLyricsWithTranslation } from './lrcParser';
import { findLrcFile, findTranslationLrcFile } from './musicScanner';

export async function readMetadataAndLyrics(track: Track): Promise<{ track: Track; lyrics: Lyrics | null }> {
    let lyrics: Lyrics | null = null;
    let ffprobeOk = false;

    try {
        const probe = await ffprobeTrack(track.filePath);
        if (probe) {
            if (probe.title) { track.title = probe.title; }
            if (probe.artist) { track.artist = probe.artist; }
            if (probe.album) { track.album = probe.album; }
            if (probe.duration > 0) { track.duration = probe.duration; }
            if (probe.sampleRate) { track.sampleRate = probe.sampleRate; }
            if (probe.bitDepth) { track.bitDepth = probe.bitDepth; }
            if (probe.bitrate) { track.bitrate = probe.bitrate; }
            if (probe.lyrics) {
                lyrics = parseLyricsText(probe.lyrics);
            }
            if (probe.lyricsTranslation && lyrics) {
                lyrics = mergeLyricsWithTranslation(lyrics, probe.lyricsTranslation);
            }
            if (probe.hasCoverArt) {
                const art = await extractCoverArt(track.filePath);
                if (art) {
                    track.albumArt = art;
                }
            }

            const hasAnyMeta = probe.title || probe.artist || probe.album;
            if (hasAnyMeta && probe.duration > 0) {
                ffprobeOk = true;
            }
        }
    } catch (e) {
        console.error('Music Radio: ffprobe failed for', track.filePath, e);
    }

    if (!ffprobeOk) {
        try {
            const metadata = await mm.parseFile(track.filePath, { skipCovers: false });

            if (!track.title && metadata.common.title) { track.title = metadata.common.title; }
            if (!track.artist && metadata.common.artist) { track.artist = metadata.common.artist; }
            if (!track.album && metadata.common.album) { track.album = metadata.common.album; }
            if ((!track.duration || track.duration <= 0) && metadata.format.duration && metadata.format.duration > 0) { track.duration = metadata.format.duration; }
            if (!track.sampleRate && metadata.format.sampleRate) { track.sampleRate = metadata.format.sampleRate; }
            if (!track.bitDepth && metadata.format.bitsPerSample) { track.bitDepth = metadata.format.bitsPerSample; }
            if (!track.bitrate && metadata.format.bitrate) { track.bitrate = metadata.format.bitrate; }

            if (!track.albumArt && metadata.common.picture && metadata.common.picture.length > 0) {
                const pic = metadata.common.picture[0];
                const base64 = pic.data.toString('base64');
                track.albumArt = `data:${pic.format};base64,${base64}`;
            }

            if (!lyrics) {
                lyrics = extractLyrics(metadata);
            }
        } catch (e) {
            console.error('Music Radio: music-metadata also failed for', track.filePath, e);
        }
    }

    const lrcPath = findLrcFile(track.filePath);
    if (lrcPath) {
        try {
            const lrcContent = fs.readFileSync(lrcPath, 'utf-8');
            const lrcLyrics = parseLrc(lrcContent);
            if (lrcLyrics.lines.length > 0) {
                lyrics = lrcLyrics;
            }
        } catch { /* ignore */ }
    }

    const trLrcPath = findTranslationLrcFile(track.filePath);
    if (trLrcPath && lyrics) {
        try {
            const trContent = fs.readFileSync(trLrcPath, 'utf-8');
            lyrics = mergeLyricsWithTranslation(lyrics, trContent);
        } catch { /* ignore */ }
    }

    return { track, lyrics };
}

function extractLyrics(metadata: mm.IAudioMetadata): Lyrics | null {
    const nativeResult = extractNativeLyrics(metadata);
    if (nativeResult) { return nativeResult; }

    const rawLyrics = metadata.common.lyrics;
    if (rawLyrics && rawLyrics.length > 0) {
        const mainLyric = findReadableLyric(rawLyrics);
        if (mainLyric) {
            const parsed = parseLyricsText(mainLyric);
            if (rawLyrics.length > 1) {
                const transLyric = findReadableLyric(rawLyrics.slice(1));
                if (transLyric && isDifferentLanguage(mainLyric, transLyric)) {
                    return mergeLyricsWithTranslation(parsed, transLyric);
                }
            }
            return parsed;
        }
    }

    return null;
}

function findReadableLyric(candidates: string[]): string | null {
    for (const text of candidates) {
        if (typeof text !== 'string') { continue; }
        if (text.trim().length === 0) { continue; }
        if (isReadableText(text)) {
            return text;
        }
    }
    return null;
}

function isReadableText(text: string): boolean {
    const sample = text.substring(0, 300);
    let printable = 0;
    const len = sample.length;
    for (let i = 0; i < len; i++) {
        const code = sample.charCodeAt(i);
        if ((code >= 0x20 && code < 0xFFFE) || code === 0x0A || code === 0x0D) {
            printable++;
        }
    }
    return len > 0 && (printable / len) > 0.85;
}

function isDifferentLanguage(text1: string, text2: string): boolean {
    const hasCJK1 = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text1.substring(0, 100));
    const hasCJK2 = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text2.substring(0, 100));
    const hasLatin1 = /[a-zA-Z]/.test(text1.substring(0, 100));
    const hasLatin2 = /[a-zA-Z]/.test(text2.substring(0, 100));
    return (hasCJK1 !== hasCJK2) || (hasLatin1 !== hasLatin2);
}

function extractNativeLyrics(metadata: mm.IAudioMetadata): Lyrics | null {
    const native = metadata.native;
    if (!native) { return null; }

    let usltText: string | null = null;
    let usltTranslation: string | null = null;
    let vorbisLyrics: string | null = null;

    for (const [, tags] of Object.entries(native)) {
        for (const tag of tags) {
            const id = String(tag.id).toUpperCase();

            if (id === 'USLT' || id === 'UNSYNCEDLYRICS' || id === 'UNSYNCED LYRICS') {
                const text = extractTextFromTagValue(tag.value);
                if (text && text.trim().length > 0) {
                    if (!usltText) {
                        usltText = text;
                    } else if (!usltTranslation && isDifferentLanguage(usltText, text)) {
                        usltTranslation = text;
                    }
                }
            }

            if (id === 'LYRICS' || id === 'LYRICIST' || id === 'UNSYNCEDLYRICS') {
                const text = extractTextFromTagValue(tag.value);
                if (text && text.trim().length > 0 && isReadableText(text)) {
                    vorbisLyrics = text;
                }
            }
        }
    }

    if (usltText) {
        const parsed = parseLyricsText(usltText);
        if (usltTranslation) {
            return mergeLyricsWithTranslation(parsed, usltTranslation);
        }
        return parsed;
    }

    if (vorbisLyrics) {
        return parseLyricsText(vorbisLyrics);
    }

    return null;
}

function extractTextFromTagValue(value: any): string | null {
    if (!value) { return null; }
    if (typeof value === 'string') { return value; }
    if (Buffer.isBuffer(value)) {
        return tryDecodeBuffer(value);
    }
    if (typeof value === 'object') {
        if (value.text && typeof value.text === 'string') { return value.text; }
        if (value.lyrics && typeof value.lyrics === 'string') { return value.lyrics; }
        if (value.descriptor !== undefined && value.language !== undefined) {
            if (value.text) { return typeof value.text === 'string' ? value.text : null; }
            if (value.lyrics) { return typeof value.lyrics === 'string' ? value.lyrics : null; }
        }
        for (const key of Object.keys(value)) {
            const v = value[key];
            if (typeof v === 'string' && v.length > 20 && isReadableText(v)) {
                return v;
            }
        }
        if (Buffer.isBuffer(value.value)) {
            return tryDecodeBuffer(value.value);
        }
    }
    const str = String(value);
    if (str !== '[object Object]' && str.length > 0) { return str; }
    return null;
}

function tryDecodeBuffer(buf: Buffer): string {
    try {
        const utf8 = buf.toString('utf-8');
        if (isReadableText(utf8)) { return utf8; }
    } catch { /* ignore */ }
    try {
        const utf16 = buf.toString('utf-16le');
        if (isReadableText(utf16)) { return utf16; }
    } catch { /* ignore */ }
    return buf.toString('utf-8');
}

function parseLyricsText(text: string): Lyrics {
    if (text.includes('[') && /\[\d{1,2}:\d{2}/.test(text)) {
        return parseLrc(text);
    }
    const lines = text.split('\n').map((t, i) => ({
        time: i * 5,
        text: t.trim(),
    }));
    return { type: 'unsynced', lines, rawText: text };
}

interface FfprobeResult {
    title?: string;
    artist?: string;
    album?: string;
    duration: number;
    lyrics?: string;
    lyricsTranslation?: string;
    hasCoverArt: boolean;
    sampleRate?: number;
    bitDepth?: number;
    bitrate?: number;
}

async function ffprobeTrack(filePath: string): Promise<FfprobeResult | null> {
    return new Promise((resolve) => {
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath,
        ];

        execFile('ffprobe', args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                console.error('Music Radio: ffprobe error', error.message);
                resolve(null);
                return;
            }

            try {
                const data = JSON.parse(stdout);
                const result: FfprobeResult = { duration: 0, hasCoverArt: false };

                const formatTags = data.format?.tags || {};
                result.duration = data.format?.duration ? parseFloat(data.format.duration) : 0;
                result.title = firstOf(formatTags, 'title', 'TITLE');
                result.artist = firstOf(formatTags, 'artist', 'ARTIST', 'album_artist', 'ALBUM_ARTIST');
                result.album = firstOf(formatTags, 'album', 'ALBUM');

                const lyricsStr = findLyricsTag(formatTags);
                if (lyricsStr && isReadableText(lyricsStr)) {
                    result.lyrics = lyricsStr;
                }

                if (data.streams) {
                    for (const stream of data.streams) {
                        if (stream.codec_type === 'video' ||
                            stream.codec_name === 'mjpeg' ||
                            stream.codec_name === 'png' ||
                            stream.codec_name === 'jpg') {
                            if (stream.width && stream.height && stream.width < 2000 && stream.height < 2000) {
                                result.hasCoverArt = true;
                            }
                        }

                        if (stream.codec_type === 'audio') {
                            if (stream.sample_rate && !result.sampleRate) {
                                result.sampleRate = parseInt(stream.sample_rate, 10) || undefined;
                            }
                            if (stream.bits_per_sample && !result.bitDepth) {
                                result.bitDepth = parseInt(stream.bits_per_sample, 10) || undefined;
                            }
                            if (stream.bit_depth && !result.bitDepth) {
                                result.bitDepth = parseInt(stream.bit_depth, 10) || undefined;
                            }
                            if (stream.bit_rate && !result.bitrate) {
                                result.bitrate = parseInt(stream.bit_rate, 10) || undefined;
                            }
                        }

                        if (stream.tags) {
                            const st = stream.tags;
                            if (!result.title) { result.title = firstOf(st, 'title', 'TITLE'); }
                            if (!result.artist) { result.artist = firstOf(st, 'artist', 'ARTIST'); }
                            if (!result.album) { result.album = firstOf(st, 'album', 'ALBUM'); }
                            if (!result.lyrics) {
                                const sl = findLyricsTag(st);
                                if (sl && isReadableText(sl)) { result.lyrics = sl; }
                            }
                        }
                    }
                }

                resolve(result);
            } catch (e) {
                console.error('Music Radio: ffprobe parse error', e);
                resolve(null);
            }
        });
    });
}

async function extractCoverArt(filePath: string): Promise<string | null> {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `music-radio-cover-${Date.now()}.jpg`);

    return new Promise((resolve) => {
        const args = [
            '-i', filePath,
            '-an',
            '-vcodec', 'mjpeg',
            '-q:v', '5',
            '-y',
            tmpFile,
        ];

        execFile('ffmpeg', args, { timeout: 10000 }, (error) => {
            if (error) {
                try { if (fs.existsSync(tmpFile)) { fs.unlinkSync(tmpFile); } } catch { /* ignore */ }
                resolve(null);
                return;
            }

            try {
                if (fs.existsSync(tmpFile)) {
                    const stat = fs.statSync(tmpFile);
                    if (stat.size > 0) {
                        const data = fs.readFileSync(tmpFile);
                        const base64 = data.toString('base64');
                        fs.unlinkSync(tmpFile);
                        resolve(`data:image/jpeg;base64,${base64}`);
                        return;
                    }
                    fs.unlinkSync(tmpFile);
                }
            } catch (e) {
                console.error('Music Radio: cover art read error', e);
                try { if (fs.existsSync(tmpFile)) { fs.unlinkSync(tmpFile); } } catch { /* ignore */ }
            }

            resolve(null);
        });
    });
}

function firstOf(obj: Record<string, any>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const val = obj[key];
        if (val !== undefined && val !== null) {
            if (typeof val === 'string') { return val; }
            return String(val);
        }
    }
    return undefined;
}

function findLyricsTag(tags: Record<string, any>): string | undefined {
    const exactKeys = ['LYRICS', 'lyrics', 'UNSYNCEDLYRICS', 'UNSYNCED_LYRICS', 'unsynced lyrics', 'UNSYNCED LYRICS'];
    for (const key of exactKeys) {
        if (tags[key] !== undefined) { return typeof tags[key] === 'string' ? tags[key] : String(tags[key]); }
    }
    for (const key of Object.keys(tags)) {
        const lower = key.toLowerCase();
        if (lower === 'lyrics' || lower.includes('lyrics') || lower.includes('unsynced')) {
            const val = tags[key];
            if (val !== undefined && val !== null) {
                return typeof val === 'string' ? val : String(val);
            }
        }
    }
    return undefined;
}