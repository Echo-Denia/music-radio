﻿import * as vscode from 'vscode';
import * as path from 'path';
import { PlayerManager } from './playerManager';
import { MusicLibraryProvider, searchTracks } from './musicLibrary';
import { PlayerWebviewPanel } from './webviewPlayer';
import { LyricsWebviewView } from './webviewLyrics';
import { startServer, stopServer, getHostPort, registerPlayerManager } from './audioServer';
import { RemotePlayerClient } from './remoteClient';
import { Track } from './types';

let playerManager: PlayerManager;
let musicLibraryProvider: MusicLibraryProvider;
let lyricsViewProvider: LyricsWebviewView;
let extensionContext: vscode.ExtensionContext;
let lyricsStatusBarItem: vscode.StatusBarItem;
let prevStatusBarItem: vscode.StatusBarItem;
let playStatusBarItem: vscode.StatusBarItem;
let nextStatusBarItem: vscode.StatusBarItem;
let openPlayerStatusBarItem: vscode.StatusBarItem;

let isHostMode = true;
let remoteClient: RemotePlayerClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;

    const isRemoteWindow = vscode.env.remoteName !== undefined;

    if (isRemoteWindow) {
        isHostMode = false;
        vscode.commands.executeCommand('setContext', 'music-radio:remoteMode', true);
        const hostPort = await getHostPort();
        if (hostPort !== null) {
            activateClientMode(context, hostPort);
        } else {
            activateRemoteStandaloneMode(context);
        }
    } else {
        const hostPort = await getHostPort();
        if (hostPort !== null) {
            isHostMode = false;
            vscode.commands.executeCommand('setContext', 'music-radio:remoteMode', true);
            activateClientMode(context, hostPort);
        } else {
            isHostMode = true;
            vscode.commands.executeCommand('setContext', 'music-radio:remoteMode', false);
            await activateHostMode(context);
        }
    }
}

async function activateHostMode(context: vscode.ExtensionContext) {
    try {
        await startServer();
    } catch (e) {
        vscode.window.showErrorMessage(`Music Radio: Failed to start audio server: ${e}`);
        return;
    }

    playerManager = new PlayerManager(context);
    registerPlayerManager(playerManager);
    musicLibraryProvider = new MusicLibraryProvider(playerManager, context.extensionUri);

    const libraryView = vscode.window.registerTreeDataProvider(
        'music-radio-library',
        musicLibraryProvider,
    );

    lyricsViewProvider = new LyricsWebviewView(context.extensionUri, playerManager);
    const lyricsView = vscode.window.registerWebviewViewProvider(
        LyricsWebviewView.viewType,
        lyricsViewProvider,
    );

    prevStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1004);
    prevStatusBarItem.text = '$(chevron-left)';
    prevStatusBarItem.tooltip = 'Previous Track';
    prevStatusBarItem.command = 'music-radio.previous';
    prevStatusBarItem.show();

    playStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1003);
    playStatusBarItem.text = '$(play)';
    playStatusBarItem.tooltip = 'Play/Pause';
    playStatusBarItem.command = 'music-radio.playPause';
    playStatusBarItem.show();

    nextStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1002);
    nextStatusBarItem.text = '$(chevron-right)';
    nextStatusBarItem.tooltip = 'Next Track';
    nextStatusBarItem.command = 'music-radio.next';
    nextStatusBarItem.show();

    openPlayerStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
    openPlayerStatusBarItem.text = '$(music)';
    openPlayerStatusBarItem.tooltip = 'Open Player';
    openPlayerStatusBarItem.command = 'music-radio.openPlayer';
    openPlayerStatusBarItem.show();

    lyricsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    lyricsStatusBarItem.text = '';
    lyricsStatusBarItem.tooltip = '';
    lyricsStatusBarItem.command = 'music-radio.openPlayer';
    lyricsStatusBarItem.show();

    playerManager.onDidChange((event) => {
        updateStatusBar();
        if (event === 'timeUpdate' || event === 'trackChange' || event === 'seek' || event === 'lyricsUpdate') {
            updateLyricsStatusBar();
        }
    });

    const openPlayerCmd = vscode.commands.registerCommand('music-radio.openPlayer', () => {
        PlayerWebviewPanel.createOrShow(context.extensionUri, playerManager);
    });

    const reloadCmd = vscode.commands.registerCommand('music-radio.reload', () => {
        restartExtension();
    });

    const playPauseCmd = vscode.commands.registerCommand('music-radio.playPause', () => {
        playerManager.togglePlayPause();
    });

    const nextCmd = vscode.commands.registerCommand('music-radio.next', async () => {
        await playerManager.next();
    });

    const previousCmd = vscode.commands.registerCommand('music-radio.previous', async () => {
        await playerManager.previous();
    });

    const toggleShuffleCmd = vscode.commands.registerCommand('music-radio.toggleShuffle', () => {
        playerManager.toggleShuffle();
    });

    const toggleRepeatCmd = vscode.commands.registerCommand('music-radio.toggleRepeat', () => {
        playerManager.toggleRepeat();
    });

    const addFolderCmd = vscode.commands.registerCommand('music-radio.addFolder', async () => {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Music Folder',
        });
        if (result && result.length > 0) {
            await playerManager.addMusicFolder(result[0].fsPath);
            musicLibraryProvider.refresh();
            vscode.window.showInformationMessage(`Music folder added: ${result[0].fsPath}`);
        }
    });

    const scanFolderCmd = vscode.commands.registerCommand('music-radio.scanFolder', async () => {
        await playerManager.scanAllFolders();
        musicLibraryProvider.refresh();
        vscode.window.showInformationMessage('Music folders scanned');
    });

    const playTrackCmd = vscode.commands.registerCommand('music-radio.playTrack', async (arg: any) => {
        const track = extractTrack(arg);
        if (track) {
            await playerManager.playTrack(track);
            PlayerWebviewPanel.createOrShow(context.extensionUri, playerManager);
        }
    });

    const playNextCmd = vscode.commands.registerCommand('music-radio.playNext', (arg: any) => {
        const track = extractTrack(arg);
        if (track) {
            playerManager.playNext(track);
            vscode.window.showInformationMessage(`"${track.title}" will play next`);
        }
    });

    const removeFromPlaylistCmd = vscode.commands.registerCommand('music-radio.removeFromPlaylist', (item: any) => {
        if (item && item.track) {
            const idx = playerManager.GetPlaylist.findIndex(t => t.id === item.track.id);
            if (idx >= 0) {
                playerManager.removeFromPlaylist(idx);
            }
        }
    });

    const clearPlaylistCmd = vscode.commands.registerCommand('music-radio.clearPlaylist', () => {
        playerManager.clearPlaylist();
    });

    const refreshLibraryCmd = vscode.commands.registerCommand('music-radio.refreshLibrary', async () => {
        await playerManager.scanAllFolders();
        musicLibraryProvider.refresh();
        vscode.window.showInformationMessage('Music library refreshed');
    });

    const searchCmd = vscode.commands.registerCommand('music-radio.search', async () => {
        const query = await vscode.window.showInputBox({
            prompt: 'Search music by title, artist, or album',
            placeHolder: 'e.g. 夢花火, sawamurah, anime...',
        });

        if (query === undefined) {
            return;
        }

        if (!query.trim()) {
            musicLibraryProvider.setSearchResults(null);
            return;
        }

        const results = searchTracks(playerManager, query);
        musicLibraryProvider.setSearchResults(results);

        if (results.length === 0) {
            vscode.window.showInformationMessage(`No results for "${query}"`);
        } else {
            vscode.window.showInformationMessage(`Found ${results.length} results for "${query}"`);
        }
    });

    const clearSearchCmd = vscode.commands.registerCommand('music-radio.clearSearch', () => {
        musicLibraryProvider.setSearchResults(null);
    });
    const revealInExplorerCmd = vscode.commands.registerCommand('music-radio.revealInExplorer', async (arg: any) => {
        const track = extractTrack(arg);
        if (track) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(track.filePath));
        }
    });

    const copyAbsolutePathCmd = vscode.commands.registerCommand('music-radio.copyAbsolutePath', async (arg: any) => {
        const track = extractTrack(arg);
        if (track) {
            await vscode.env.clipboard.writeText(track.filePath);
            vscode.window.showInformationMessage(`Path copied: ${track.filePath}`);
        }
    });

    const copyRelativePathCmd = vscode.commands.registerCommand('music-radio.copyRelativePath', async (arg: any) => {
        const track = extractTrack(arg);
        if (track) {
            const wsFolders = vscode.workspace.workspaceFolders;
            let relPath = track.filePath;
            if (wsFolders && wsFolders.length > 0) {
                for (const wf of wsFolders) {
                    const prefix = wf.uri.fsPath;
                    if (track.filePath.startsWith(prefix)) {
                        relPath = path.relative(prefix, track.filePath);
                        break;
                    }
                }
            }
            await vscode.env.clipboard.writeText(relPath);
            vscode.window.showInformationMessage(`Relative path copied: ${relPath}`);
        }
    });

    const removeFolderCmd = vscode.commands.registerCommand('music-radio.removeFolder', async (arg: any) => {
        let folderPath: string | undefined;
        if (arg && arg.folderPath) {
            folderPath = arg.folderPath;
        } else if (arg && arg.label) {
            const folders = playerManager.GetMusicFolders;
            const folderName = path.basename(arg.label);
            folderPath = folders.find(f => path.basename(f) === folderName);
        }

        if (!folderPath) {
            vscode.window.showWarningMessage('Could not identify the folder to remove');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Remove "${path.basename(folderPath)}" from Music Radio?`,
            { modal: false },
            'Remove',
        );

        if (confirm === 'Remove') {
            await playerManager.removeMusicFolder(folderPath);
            musicLibraryProvider.refresh();
            vscode.window.showInformationMessage(`Folder removed: ${path.basename(folderPath)}`);
        }
    });

    const reloadFolderCmd = vscode.commands.registerCommand('music-radio.reloadFolder', async (arg: any) => {
        let folderPath: string | undefined;
        if (arg && arg.folderPath) {
            folderPath = arg.folderPath;
        } else if (arg && arg.label) {
            const folders = playerManager.GetMusicFolders;
            const folderName = path.basename(arg.label);
            folderPath = folders.find(f => path.basename(f) === folderName);
        }

        if (!folderPath) {
            vscode.window.showWarningMessage('Could not identify the folder to reload');
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Reloading "${path.basename(folderPath)}"...`,
                cancellable: false,
            },
            async () => {
                await playerManager.reloadMusicFolder(folderPath!);
                musicLibraryProvider.refresh();
            },
        );
        vscode.window.showInformationMessage(`Folder reloaded: ${path.basename(folderPath)}`);
    });

    context.subscriptions.push(
        libraryView,
        lyricsView,
        lyricsStatusBarItem,
        prevStatusBarItem,
        playStatusBarItem,
        nextStatusBarItem,
        openPlayerStatusBarItem,
        openPlayerCmd,
        playPauseCmd,
        nextCmd,
        previousCmd,
        toggleShuffleCmd,
        toggleRepeatCmd,
        addFolderCmd,
        scanFolderCmd,
        playTrackCmd,
        playNextCmd,
        removeFromPlaylistCmd,
        clearPlaylistCmd,
        refreshLibraryCmd,
        searchCmd,
        clearSearchCmd,
        revealInExplorerCmd,
        copyAbsolutePathCmd,
        copyRelativePathCmd,
        removeFolderCmd,
        reloadFolderCmd,
        reloadCmd,
    );

    autoScanFolders();
}

function activateClientMode(context: vscode.ExtensionContext, hostPort: number) {
    remoteClient = new RemotePlayerClient(hostPort, () => getHostPort());

    const prevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1004);
    prevItem.text = '$(chevron-left)';
    prevItem.tooltip = 'Previous Track';
    prevItem.command = 'music-radio.previous';
    prevItem.show();

    const playItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1003);
    playItem.text = '$(play)';
    playItem.tooltip = 'Play/Pause';
    playItem.command = 'music-radio.playPause';
    playItem.show();

    const nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1002);
    nextItem.text = '$(chevron-right)';
    nextItem.tooltip = 'Next Track';
    nextItem.command = 'music-radio.next';
    nextItem.show();

    const musicItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
    musicItem.text = '$(music)';
    musicItem.tooltip = 'Music Radio (Remote)';
    musicItem.command = 'music-radio.openPlayer';
    musicItem.show();

    const lyricsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    lyricsItem.text = '';
    lyricsItem.tooltip = '';
    lyricsItem.command = 'music-radio.openPlayer';
    lyricsItem.show();

    const cmds: vscode.Disposable[] = [
        vscode.commands.registerCommand('music-radio.openPlayer', () => {
            vscode.window.showInformationMessage('Music Radio: Player is running in the local window. Use the status bar controls to manage playback.');
        }),
        vscode.commands.registerCommand('music-radio.reload', () => {
            restartExtension();
        }),
        vscode.commands.registerCommand('music-radio.playPause', () => {
            remoteClient?.togglePlayPause();
        }),
        vscode.commands.registerCommand('music-radio.next', () => {
            remoteClient?.next();
        }),
        vscode.commands.registerCommand('music-radio.previous', () => {
            remoteClient?.previous();
        }),
        vscode.commands.registerCommand('music-radio.toggleShuffle', () => {
            remoteClient?.toggleShuffle();
        }),
        vscode.commands.registerCommand('music-radio.toggleRepeat', () => {
            remoteClient?.toggleRepeat();
        }),
    ];

    remoteClient.onDidChange(() => {
        if (!remoteClient?.IsConnected) {
            playItem.text = '$(play)';
            playItem.tooltip = 'Play/Pause (Disconnected)';
            musicItem.text = '$(debug-disconnect)';
            musicItem.tooltip = 'Music Radio: Disconnected from local window';
            lyricsItem.text = '';
            lyricsItem.tooltip = '';
            return;
        }

        playItem.text = remoteClient.GetIsPlaying ? '$(debug-pause)' : '$(play)';
        playItem.tooltip = remoteClient.GetIsPlaying ? 'Pause' : 'Play';

        const currentLyrics = remoteClient.GetLyrics;
        const currentTime = remoteClient.GetCurrentTime;
        const track = remoteClient.getCurrentTrack;

        let currentLine = '';
        if (currentLyrics && currentLyrics.lines && currentLyrics.lines.length > 0 && currentLyrics.type === 'synced') {
            for (let i = currentLyrics.lines.length - 1; i >= 0; i--) {
                if (currentTime >= currentLyrics.lines[i].time) {
                    currentLine = currentLyrics.lines[i].text;
                    break;
                }
            }
        }

        if (currentLine.length > 40) {
            currentLine = currentLine.substring(0, 40) + '...';
        }

        lyricsItem.text = currentLine ? `🎵 ${currentLine}` : '';

        const trackTooltip = buildTrackTooltip(track);
        lyricsItem.tooltip = trackTooltip;
        musicItem.tooltip = trackTooltip
            ? `Music Radio (Remote)\n\n${trackTooltip}`
            : 'Music Radio (Remote)';
    });

    context.subscriptions.push(
        remoteClient,
        prevItem, playItem, nextItem, musicItem, lyricsItem,
        ...cmds,
    );
}

function activateRemoteStandaloneMode(context: vscode.ExtensionContext) {
    const prevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1004);
    prevItem.text = '$(chevron-left)';
    prevItem.tooltip = 'Previous Track (Waiting for local window...)';
    prevItem.command = 'music-radio.previous';
    prevItem.show();

    const playItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1003);
    playItem.text = '$(play)';
    playItem.tooltip = 'Play/Pause (Waiting for local window...)';
    playItem.command = 'music-radio.playPause';
    playItem.show();

    const nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1002);
    nextItem.text = '$(chevron-right)';
    nextItem.tooltip = 'Next Track (Waiting for local window...)';
    nextItem.command = 'music-radio.next';
    nextItem.show();

    const musicItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
    musicItem.text = '$(debug-disconnect)';
    musicItem.tooltip = `Music Radio: Remote window (${vscode.env.remoteName}) — Waiting for local window`;
    musicItem.command = 'music-radio.openPlayer';
    musicItem.show();

    const lyricsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    lyricsItem.text = '';
    lyricsItem.tooltip = '';
    lyricsItem.command = 'music-radio.openPlayer';
    lyricsItem.show();

    let retryTimer: ReturnType<typeof setInterval> | null = null;

    const tryConnect = async () => {
        const hostPort = await getHostPort();
        if (hostPort !== null) {
            if (retryTimer) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
            prevItem.dispose();
            playItem.dispose();
            nextItem.dispose();
            musicItem.dispose();
            lyricsItem.dispose();
            activateClientMode(context, hostPort);
        }
    };

    retryTimer = setInterval(tryConnect, 5000);

    const cmds: vscode.Disposable[] = [
        vscode.commands.registerCommand('music-radio.openPlayer', () => {
            vscode.window.showInformationMessage('Music Radio: Waiting for the local window to start. The player will connect automatically once available.');
        }),
        vscode.commands.registerCommand('music-radio.reload', () => {
            restartExtension();
        }),
        vscode.commands.registerCommand('music-radio.playPause', () => {
            vscode.window.showInformationMessage('Music Radio: Not connected to local window yet. Please wait...');
        }),
        vscode.commands.registerCommand('music-radio.next', () => {
            vscode.window.showInformationMessage('Music Radio: Not connected to local window yet. Please wait...');
        }),
        vscode.commands.registerCommand('music-radio.previous', () => {
            vscode.window.showInformationMessage('Music Radio: Not connected to local window yet. Please wait...');
        }),
    ];

    context.subscriptions.push({
        dispose: () => {
            if (retryTimer) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
        }
    });

    context.subscriptions.push(
        prevItem, playItem, nextItem, musicItem, lyricsItem,
        ...cmds,
    );
}

async function autoScanFolders() {
    const folders = playerManager.GetMusicFolders;
    if (folders.length > 0) {
        await playerManager.scanAllFolders();
        musicLibraryProvider.refresh();
        await playerManager.restorePlaybackState();
        if (playerManager.getCurrentTrack) {
            PlayerWebviewPanel.createOrShow(extensionContext.extensionUri, playerManager);
        }
        if (PlayerWebviewPanel.currentPanel) {
            PlayerWebviewPanel.currentPanel.refresh();
        }
    }
}

function updateStatusBar() {
    const isPlaying = playerManager.GetIsPlaying;

    playStatusBarItem.text = isPlaying ? '$(debug-pause)' : '$(play)';
    playStatusBarItem.tooltip = isPlaying ? 'Pause' : 'Play';
}

function updateLyricsStatusBar() {
    const lyrics = playerManager.GetLyrics;
    const currentTime = playerManager.getEstimatedCurrentTime();
    const track = playerManager.getCurrentTrack;

    if (!lyrics || !lyrics.lines || lyrics.lines.length === 0 || lyrics.type !== 'synced') {
        lyricsStatusBarItem.text = '';
        lyricsStatusBarItem.tooltip = '';
        return;
    }

    let currentLine = '';
    for (let i = lyrics.lines.length - 1; i >= 0; i--) {
        if (currentTime >= lyrics.lines[i].time) {
            currentLine = lyrics.lines[i].text;
            break;
        }
    }

    if (currentLine.length > 40) {
        currentLine = currentLine.substring(0, 40) + '...';
    }

    lyricsStatusBarItem.text = currentLine ? `🎵 ${currentLine}` : '';

    const trackTooltip = buildTrackTooltip(track);
    lyricsStatusBarItem.tooltip = trackTooltip;
    openPlayerStatusBarItem.tooltip = trackTooltip
        ? `Open Player\n\n${trackTooltip}`
        : 'Open Player';
}

function buildTrackTooltip(track: Track | null): string {
    if (!track) {
        return '';
    }
    const parts: string[] = [];
    parts.push(`${track.title} - ${track.artist}`);
    if (track.album && track.album !== 'Unknown') {
        parts.push(track.album);
    }
    const metaParts: string[] = [];
    if (track.format) { metaParts.push(track.format.toUpperCase()); }
    if (track.sampleRate) { metaParts.push(`${track.sampleRate}Hz`); }
    if (track.bitDepth) { metaParts.push(`${track.bitDepth}bit`); }
    if (track.bitrate) { metaParts.push(`${track.bitrate}kbps`); }
    if (metaParts.length > 0) {
        parts.push(metaParts.join(' | '));
    }
    return parts.join('\n');
}

function extractTrack(arg: any): Track | null {
    if (!arg) { return null; }
    if (arg.filePath && arg.id) { return arg as Track; }
    if (arg.track && arg.track.filePath) { return arg.track as Track; }
    return null;
}

async function disposeExtension(): Promise<void> {
    const subs = extensionContext.subscriptions.splice(0, extensionContext.subscriptions.length);
    for (const d of subs) {
        try { d.dispose(); } catch { /* ignore */ }
    }

    if (isHostMode) {
        playerManager?.dispose();
        PlayerWebviewPanel.disposeCurrent();
        await stopServer();
    } else {
        remoteClient?.dispose();
        remoteClient = undefined;
    }
}

async function restartExtension(): Promise<void> {
    await disposeExtension();
    await activate(extensionContext);
    if (isHostMode && playerManager) {
        PlayerWebviewPanel.createOrShow(extensionContext.extensionUri, playerManager);
    }
}

export function deactivate() {
    if (isHostMode) {
        playerManager?.dispose();
        stopServer();
    } else {
        remoteClient?.dispose();
    }
}