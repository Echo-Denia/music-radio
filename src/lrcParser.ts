import { Lyrics, LyricsLine } from './types';

export function parseLrc(lrcText: string): Lyrics {
    let text = lrcText;

    const prefixPatterns = ['原歌词:', '原歌词：', 'Original Lyrics:', 'Lyrics:'];
    for (const prefix of prefixPatterns) {
        if (text.startsWith(prefix)) {
            text = text.substring(prefix.length);
            break;
        }
    }
    text = text.trim();

    const lines: LyricsLine[] = [];
    const rawLines = text.split('\n');
    let lastTimestampedLine: LyricsLine | null = null;

    for (const line of rawLines) {
        const timeRegex = /\[(\d{1,2}):(\d{2})([.:]\d{1,3})?\]/g;
        const times: number[] = [];
        let match: RegExpExecArray | null;

        while ((match = timeRegex.exec(line)) !== null) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            let ms = 0;
            if (match[3]) {
                const raw = match[3].slice(1);
                ms = parseInt(raw.padEnd(3, '0').slice(0, 3), 10);
            }
            times.push(min * 60 + sec + ms / 1000);
        }

        const textPart = line.replace(/\[\d{1,2}:\d{2}([.:]\d{1,3})?\]/g, '').trim();

        if (times.length > 0 && textPart.length > 0) {
            for (const time of times) {
                const newLine: LyricsLine = { time, text: textPart };
                lines.push(newLine);
                lastTimestampedLine = newLine;
            }
        } else if (times.length === 0 && textPart.length > 0 && lastTimestampedLine && !lastTimestampedLine.translation) {
            lastTimestampedLine.translation = textPart;
        }
    }

    lines.sort((a, b) => a.time - b.time);

    return {
        type: lines.length > 0 ? 'synced' : 'unsynced',
        lines,
        rawText: lrcText,
    };
}

export function parseLrcWithTranslation(originalLrc: string, translationLrc: string): Lyrics {
    const original = parseLrc(originalLrc);
    const translation = parseLrc(translationLrc);

    if (original.type === 'synced' && translation.type === 'synced') {
        const transMap = new Map<number, string>();
        for (const line of translation.lines) {
            const key = Math.round(line.time * 10);
            transMap.set(key, line.text);
        }

        for (const line of original.lines) {
            const key = Math.round(line.time * 10);
            const trans = transMap.get(key);
            if (trans) {
                line.translation = trans;
            }
        }
    }

    return original;
}

export function mergeLyricsWithTranslation(lyrics: Lyrics, translationLrc: string): Lyrics {
    const translation = parseLrc(translationLrc);
    if (translation.type !== 'synced') {
        if (lyrics.type === 'unsynced' && translation.type === 'unsynced') {
            const mergedLines = lyrics.lines.map((line, i) => {
                if (i < translation.lines.length) {
                    return { ...line, translation: translation.lines[i].text };
                }
                return line;
            });
            return { ...lyrics, lines: mergedLines };
        }
        return lyrics;
    }

    const transMap = new Map<number, string>();
    for (const line of translation.lines) {
        const key = Math.round(line.time * 10);
        transMap.set(key, line.text);
    }

    const mergedLines = lyrics.lines.map(line => {
        const key = Math.round(line.time * 10);
        const trans = transMap.get(key);
        return trans ? { ...line, translation: trans } : line;
    });

    return { ...lyrics, lines: mergedLines };
}