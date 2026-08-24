import * as vscode from 'vscode';
import * as path from 'path';
import { Track } from './types';
import { PlayerManager } from './playerManager';

const FORMAT_ICONS: Record<string, string> = {
    mp3: 'icon-mp3.svg',
    flac: 'icon-flac.svg',
    wav: 'icon-wav.svg',
    ogg: 'icon-ogg.svg',
    m4a: 'icon-m4a.svg',
    aac: 'icon-aac.svg',
    wma: 'icon-wma.svg',
    opus: 'icon-opus.svg',
    mp4: 'icon-mp4.svg',
};

export class MusicLibraryProvider implements vscode.TreeDataProvider<MusicTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MusicTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private extensionUri: vscode.Uri;
    private searchResults: Track[] | null = null;

    constructor(
        private playerManager: PlayerManager,
        extensionUri: vscode.Uri,
    ) {
        this.extensionUri = extensionUri;

        playerManager.onDidChange((event) => {
            if (event === 'playlistChange') {
                this.refresh();
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setSearchResults(results: Track[] | null): void {
        this.searchResults = results;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: MusicTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MusicTreeItem): MusicTreeItem[] {
        if (!element) {
            return this.getRootItems();
        }

        if (element.contextValue === 'folder') {
            return this.getTrackItems(element.folderPath!);
        }

        if (element.contextValue === 'searchResult') {
            return this.getSearchResultItems();
        }

        return [];
    }

    private getRootItems(): MusicTreeItem[] {
        const items: MusicTreeItem[] = [];

        if (this.searchResults !== null) {
            const searchItem = new MusicTreeItem(
                `Search Results (${this.searchResults.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                'searchResult',
            );
            searchItem.iconPath = new vscode.ThemeIcon('search');
            items.push(searchItem);
            return items;
        }

        const folders = this.playerManager.GetMusicFolders;
        if (folders.length === 0) {
            return [new MusicTreeItem('No folders added. Click + to add a folder.', vscode.TreeItemCollapsibleState.None, 'empty')];
        }

        for (const folderPath of folders) {
            const name = path.basename(folderPath);
            const playlist = this.playerManager.GetPlaylist;
            const trackCount = playlist.filter(t => t.filePath.startsWith(folderPath)).length;
            const item = new MusicTreeItem(
                `${name} (${trackCount})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'folder',
            );
            item.folderPath = folderPath;
            item.iconPath = vscode.ThemeIcon.Folder;
            items.push(item);
        }

        return items;
    }

    private getSearchResultItems(): MusicTreeItem[] {
        if (!this.searchResults || this.searchResults.length === 0) {
            return [new MusicTreeItem('No results found', vscode.TreeItemCollapsibleState.None, 'empty')];
        }

        return this.searchResults.map(track => this.createTrackItem(track));
    }

    private getTrackItems(folderPath: string): MusicTreeItem[] {
        const playlist = this.playerManager.GetPlaylist;
        const tracks = playlist.filter(t => t.filePath.startsWith(folderPath));

        if (tracks.length === 0) {
            return [new MusicTreeItem('No music files found', vscode.TreeItemCollapsibleState.None, 'empty')];
        }

        return tracks.map(track => this.createTrackItem(track));
    }

    private createTrackItem(track: Track): MusicTreeItem {
        const label = track.artist !== 'Unknown'
            ? `${track.title} - ${track.artist}`
            : track.title;
        const item = new MusicTreeItem(label, vscode.TreeItemCollapsibleState.None, 'track');
        item.track = track;
        item.contextValue = 'track';
        item.iconPath = this.getFormatIcon(track.filePath);
        item.tooltip = `${track.title}\n${track.artist}\n${track.album}\n${track.filePath}`;
        item.description = track.artist !== 'Unknown' ? track.artist : undefined;
        item.command = {
            command: 'music-radio.playTrack',
            title: 'Play',
            arguments: [track],
        };
        return item;
    }

    private getFormatIcon(filePath: string): vscode.Uri | vscode.ThemeIcon {
        const ext = path.extname(filePath).toLowerCase().slice(1);
        const iconFile = FORMAT_ICONS[ext];
        if (iconFile) {
            return vscode.Uri.joinPath(this.extensionUri, 'media', iconFile);
        }
        return vscode.ThemeIcon.File;
    }
}

class MusicTreeItem extends vscode.TreeItem {
    public folderPath?: string;
    public track?: Track;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public contextValue: string,
    ) {
        super(label, collapsibleState);
    }
}

export function searchTracks(playerManager: PlayerManager, query: string): Track[] {
    if (!query.trim()) {
        return [];
    }

    const playlist = playerManager.GetPlaylist;
    const lowerQuery = query.toLowerCase().trim();
    const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 0);

    const scored = playlist.map(track => {
        let score = 0;
        const titleLower = (track.title || '').toLowerCase();
        const artistLower = (track.artist || '').toLowerCase();
        const albumLower = (track.album || '').toLowerCase();
        const fileLower = (track.fileName || '').toLowerCase();

        if (titleLower === lowerQuery) { score += 100; }
        if (artistLower === lowerQuery) { score += 100; }
        if (albumLower === lowerQuery) { score += 100; }

        if (titleLower.startsWith(lowerQuery)) { score += 50; }
        if (artistLower.startsWith(lowerQuery)) { score += 40; }
        if (albumLower.startsWith(lowerQuery)) { score += 30; }

        if (titleLower.includes(lowerQuery)) { score += 30; }
        if (artistLower.includes(lowerQuery)) { score += 20; }
        if (albumLower.includes(lowerQuery)) { score += 15; }
        if (fileLower.includes(lowerQuery)) { score += 5; }

        for (const word of queryWords) {
            if (titleLower.includes(word)) { score += 10; }
            if (artistLower.includes(word)) { score += 8; }
            if (albumLower.includes(word)) { score += 6; }
            if (fileLower.includes(word)) { score += 2; }
        }

        return { track, score };
    });

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.track);
}