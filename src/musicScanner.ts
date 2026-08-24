import * as fs from 'fs';
import * as path from 'path';
import { Track, SUPPORTED_EXTENSIONS } from './types';

let trackIdCounter = 0;

function generateId(): string {
    return `track_${Date.now()}_${trackIdCounter++}`;
}

export function scanDirectory(dirPath: string, extensions: string[] = SUPPORTED_EXTENSIONS): Track[] {
    const tracks: Track[] = [];
    const extSet = new Set(extensions.map(e => e.toLowerCase()));

    function walk(currentPath: string) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).slice(1).toLowerCase();
                if (extSet.has(ext)) {
                    tracks.push(createTrackFromPath(fullPath));
                }
            }
        }
    }

    walk(dirPath);
    return tracks;
}

function createTrackFromPath(filePath: string): Track {
    const fileName = path.basename(filePath, path.extname(filePath));
    const ext = path.extname(filePath).slice(1).toLowerCase();
    let dateAdded: number | undefined;
    let dateModified: number | undefined;
    let fileSize: number | undefined;
    try {
        const stat = fs.statSync(filePath);
        dateAdded = stat.birthtimeMs || stat.ctimeMs;
        dateModified = stat.mtimeMs;
        fileSize = stat.size;
    } catch { /* ignore */ }
    return {
        id: generateId(),
        filePath,
        title: fileName,
        artist: 'Unknown',
        album: 'Unknown',
        duration: 0,
        fileName,
        format: ext,
        dateAdded,
        dateModified,
        fileSize,
    };
}

export function findLrcFile(audioFilePath: string): string | null {
    const dir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const lrcPath = path.join(dir, baseName + '.lrc');
    if (fs.existsSync(lrcPath)) {
        return lrcPath;
    }
    return null;
}

export function findTranslationLrcFile(audioFilePath: string): string | null {
    const dir = path.dirname(audioFilePath);
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const candidates = [
        baseName + '.tr.lrc',
        baseName + '.translate.lrc',
        baseName + '.trans.lrc',
        baseName + '.zh.lrc',
        baseName + '.en.lrc',
    ];
    for (const c of candidates) {
        const p = path.join(dir, c);
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}