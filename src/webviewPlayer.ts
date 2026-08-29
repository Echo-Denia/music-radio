import * as vscode from 'vscode';
import * as path from 'path';
import { PlayerManager } from './playerManager';
import { Track } from './types';
import { getServerPort } from './audioServer';

export class PlayerWebviewPanel {
    public static currentPanel: PlayerWebviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, playerManager: PlayerManager): PlayerWebviewPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PlayerWebviewPanel.currentPanel) {
            PlayerWebviewPanel.currentPanel._panel.reveal(column);
            return PlayerWebviewPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'music-radio-player',
            'Music Radio',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                ],
            },
        );

        PlayerWebviewPanel.currentPanel = new PlayerWebviewPanel(panel, extensionUri, playerManager);
        return PlayerWebviewPanel.currentPanel;
    }

    private _lastPostTime = 0;
    private _pendingEvent: string | null = null;
    private _postTimer: ReturnType<typeof setTimeout> | null = null;
    private _lastTimeUpdatePost = 0;

    private constructor(
        panel: vscode.WebviewPanel,
        private extensionUri: vscode.Uri,
        private playerManager: PlayerManager,
    ) {
        this._panel = panel;
        this._panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');

        this._updateWebview();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(() => {
            if (this._panel.visible) {
                this.playerManager.wakeUp();
                const state = this.playerManager.getState();
                this._panel.webview.postMessage({
                    command: 'stateUpdate',
                    state: state,
                    event: 'panelVisible',
                });
                this._panel.webview.postMessage({ command: 'panelBecameVisible' });
            }
        }, null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => this._handleMessage(message),
            null,
            this._disposables,
        );

        playerManager.onDidChange((event) => {
            if (event === 'seek') {
                this._throttledSeekPost(event);
            } else {
                this._throttledPostState(event);
            }
        });
    }

    private async _handleMessage(message: any) {
        switch (message.command) {
            case 'playTrack': {
                const track = this.findTrackById(message.trackId);
                if (track) {
                    await this.playerManager.playTrack(track);
                }
                break;
            }
            case 'playPause':
                this.playerManager.togglePlayPause();
                break;
            case 'pause':
                this.playerManager.pause();
                break;
            case 'resume':
                this.playerManager.resume();
                break;
            case 'next':
                await this.playerManager.next();
                break;
            case 'previous':
                await this.playerManager.previous();
                break;
            case 'seek':
                this.playerManager.seekTo(message.time);
                break;
            case 'setVolume':
                this.playerManager.setVolume(message.volume);
                break;
            case 'toggleShuffle':
                this.playerManager.toggleShuffle();
                break;
            case 'toggleRepeat':
                this.playerManager.toggleRepeat();
                break;
            case 'playNext': {
                const track = this.findTrackById(message.trackId);
                if (track) {
                    this.playerManager.playNext(track);
                }
                break;
            }
            case 'addToQueue': {
                const qTrack = this.findTrackById(message.trackId);
                if (qTrack) {
                    this.playerManager.addToQueue(qTrack);
                }
                break;
            }
            case 'removeFromQueue':
                this.playerManager.removeFromQueue(message.index);
                break;
            case 'removeFromHistory':
                this.playerManager.removeFromHistory(message.index);
                break;
            case 'clearHistory':
                this.playerManager.clearHistory();
                break;
            case 'timeUpdate':
                this.playerManager.setCurrentTime(message.time);
                break;
            case 'durationUpdate':
                if (typeof message.duration === 'number') {
                    this.playerManager.updateActualDuration(message.duration);
                }
                break;
            case 'trackEnded':
                await this.playerManager.onTrackEnd(true);
                break;
            case 'audioError':
                console.error('Music Radio: audio error', message.error);
                this.playerManager.pause();
                break;
            case 'playbackBlocked':
                this.playerManager.pause();
                break;
            case 'playbackFailed':
                this.playerManager.pause();
                break;
            case 'backgroundPause':
                this.playerManager.backgroundPause();
                break;
            case 'backgroundResume':
                this.playerManager.backgroundResume(message.time);
                break;
            case 'addFolder': {
                const result = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: 'Select Music Folder',
                });
                if (result && result.length > 0) {
                    await this.playerManager.addMusicFolder(result[0].fsPath);
                    vscode.commands.executeCommand('music-radio.refreshLibrary');
                }
                break;
            }
            case 'scanFolder': {
                await this.playerManager.scanAllFolders();
                vscode.commands.executeCommand('music-radio.refreshLibrary');
                break;
            }
            case 'revealInExplorer': {
                const rTrack = this.findTrackById(message.trackId);
                if (rTrack) {
                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(rTrack.filePath));
                }
                break;
            }
            case 'copyAbsolutePath': {
                const aTrack = this.findTrackById(message.trackId);
                if (aTrack) {
                    await vscode.env.clipboard.writeText(aTrack.filePath);
                    vscode.window.showInformationMessage(`Path copied: ${aTrack.filePath}`);
                }
                break;
            }
            case 'copyRelativePath': {
                const relTrack = this.findTrackById(message.trackId);
                if (relTrack) {
                    const wsFolders = vscode.workspace.workspaceFolders;
                    let relPath = relTrack.filePath;
                    if (wsFolders && wsFolders.length > 0) {
                        for (const wf of wsFolders) {
                            const prefix = wf.uri.fsPath;
                            if (relTrack.filePath.startsWith(prefix)) {
                                relPath = path.relative(prefix, relTrack.filePath);
                                break;
                            }
                        }
                    }
                    await vscode.env.clipboard.writeText(relPath);
                    vscode.window.showInformationMessage(`Relative path copied: ${relPath}`);
                }
                break;
            }
            case 'removeFolder': {
                const folderPath = message.folderPath;
                if (folderPath) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Remove "${path.basename(folderPath)}" from Music Radio?`,
                        { modal: false },
                        'Remove',
                    );
                    if (confirm === 'Remove') {
                        await this.playerManager.removeMusicFolder(folderPath);
                        vscode.commands.executeCommand('music-radio.refreshLibrary');
                    }
                }
                break;
            }
            case 'reloadFolder': {
                const reloadPath = message.folderPath;
                if (reloadPath) {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Reloading "${path.basename(reloadPath)}"...`,
                            cancellable: false,
                        },
                        async () => {
                            await this.playerManager.reloadMusicFolder(reloadPath);
                            vscode.commands.executeCommand('music-radio.refreshLibrary');
                        },
                    );
                }
                break;
            }
            case 'seekLyrics': {
                this.playerManager.seekTo(message.time);
                break;
            }
            case 'reloadExtension': {
                vscode.commands.executeCommand('music-radio.reload');
                break;
            }
            case 'saveTunerState': {
                if (message.tunerState) {
                    this.playerManager.saveTunerState(message.tunerState);
                }
                break;
            }
        }
    }

    private findTrackById(trackId: string): Track | undefined {
        return this.playerManager.GetPlaylist.find(t => t.id === trackId)
            || this.playerManager.GetQueue.find(t => t.id === trackId)
            || this.playerManager.GetHistory.find(t => t.id === trackId);
    }

    private _throttledPostState(event: string) {
        if (event === 'timeUpdate') {
            const now = Date.now();
            if (now - this._lastTimeUpdatePost < 200) {
                this._pendingEvent = event;
                if (!this._postTimer) {
                    this._postTimer = setTimeout(() => {
                        this._postTimer = null;
                        if (this._pendingEvent) {
                            this._postState(this._pendingEvent);
                            this._pendingEvent = null;
                        }
                    }, 200);
                }
                return;
            }
            this._lastTimeUpdatePost = now;
            this._lastPostTime = now;
        } else if (event === 'trackChange') {
            if (this._postTimer) {
                clearTimeout(this._postTimer);
                this._postTimer = null;
                this._pendingEvent = null;
            }
        }
        this._postState(event);
    }

    private _seekPostTime = 0;

    private _throttledSeekPost(event: string) {
        const now = Date.now();
        if (now - this._seekPostTime < 100) {
            return;
        }
        this._seekPostTime = now;
        this._postState(event);
    }

    private _postState(event: string) {
        if (!PlayerWebviewPanel.currentPanel) { return; }
        const state = this.playerManager.getState();
        state.currentTime = this.playerManager.getEstimatedCurrentTime();
        this._panel.webview.postMessage({ command: 'stateUpdate', state, event });
    }

    private _updateWebview() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'player.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'player.css')
        );
        const nonce = getNonce();
        const port = getServerPort();

        const state = this.playerManager.getState();
        const stateJson = JSON.stringify(state);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; media-src http://127.0.0.1:${port} data: blob:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>Music Radio</title>
</head>
<body>
    <div id="app">
        <div class="player-container">
            <div class="now-playing">
                <div class="album-art" id="albumArt">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                </div>
                <div class="track-info">
                    <div class="track-title" id="trackTitle">No track selected</div>
                    <div class="track-artist" id="trackArtist">-</div>
                    <div class="track-album" id="trackAlbum">-</div>
                </div>
            </div>

            <div class="progress-container">
                <span class="time" id="currentTime">0:00</span>
                <div class="progress-bar" id="progressBar">
                    <div class="progress-fill" id="progressFill"></div>
                    <div class="progress-thumb" id="progressThumb"></div>
                </div>
                <span class="time" id="totalTime">0:00</span>
            </div>

            <div class="controls">
                <button class="control-btn" id="shuffleBtn" title="Shuffle">
                    <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
                </button>
                <button class="control-btn" id="prevBtn" title="Previous">
                    <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                </button>
                <button class="control-btn play-btn" id="playBtn" title="Play/Pause">
                    <svg viewBox="0 0 24 24" id="playIcon"><path d="M8 5v14l11-7z"/></svg>
                    <svg viewBox="0 0 24 24" id="pauseIcon" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                </button>
                <button class="control-btn" id="nextBtn" title="Next">
                    <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                </button>
                <button class="control-btn" id="repeatBtn" title="Repeat">
                    <svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
                </button>
            </div>

            <div class="volume-container">
                <svg class="volume-icon" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                <div class="volume-bar" id="volumeBar">
                    <div class="volume-fill" id="volumeFill"></div>
                </div>
                <span id="volumeValue">80%</span>
            </div>

            <button class="tuner-toggle-btn" id="tunerToggleBtn" title="Audio Tuner">
                <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
                <span>Tuner</span>
            </button>

            <div class="tuner-panel" id="tunerPanel">
                <div class="tuner-section">
                    <div class="tuner-section-header">
                        <span>Equalizer</span>
                        <div class="tuner-section-actions">
                            <button id="eqResetBtn" title="Reset EQ">
                                <svg viewBox="0 0 24 24" width="12" height="12"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.81 2.55-2.98 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/></svg>
                                Reset
                            </button>
                            <button id="spectrumToggle" title="Spectrum Analyzer">
                                <svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 5v14h18V5H3zm16 12H5V7h14v10zM7 10h2v4H7zm4-2h2v6h-2zm4 1h2v4h-2z" fill="currentColor"/></svg>
                                Spectrum
                            </button>
                            <button id="oscilloscopeToggle" title="Oscilloscope">
                                <svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 3v18h18V3H3zm16 16H5V5h14v14zM7 12h2v4H7zm4-3h2v7h-2zm4-2h2v9h-2z" fill="currentColor"/></svg>
                                Wave
                            </button>
                        </div>
                    </div>
                    <div class="eq-preset-row">
                        <select id="eqPresetSelect">
                            <option value="flat">Flat</option>
                            <option value="rock">Rock</option>
                            <option value="pop">Pop</option>
                            <option value="jazz">Jazz</option>
                            <option value="classical">Classical</option>
                            <option value="hiphop">Hip-Hop</option>
                            <option value="vocal">Vocal</option>
                            <option value="bass">Bass Boost</option>
                            <option value="treble">Treble Boost</option>
                            <option value="electronic">Electronic</option>
                            <option value="custom">Custom</option>
                        </select>
                    </div>
                    <div class="eq-curve-container">
                        <canvas id="eqCurveCanvas" width="300" height="60"></canvas>
                    </div>
                    <div class="eq-bands">
                        <div class="eq-band"><span class="eq-label">31</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">62</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">125</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">250</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">500</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">1k</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">2k</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">4k</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">8k</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                        <div class="eq-band"><span class="eq-label">16k</span><input type="range" class="eq-slider" min="-12" max="12" value="0" step="1"><span class="eq-value">0 dB</span></div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Tone</span></div>
                    <div class="tuner-slider-row">
                        <label>Bass</label>
                        <input type="range" id="bassSlider" min="-12" max="12" value="0" step="1">
                        <span class="tuner-slider-value" id="bassValue">0 dB</span>
                    </div>
                    <div class="tuner-slider-row">
                        <label>Treble</label>
                        <input type="range" id="trebleSlider" min="-12" max="12" value="0" step="1">
                        <span class="tuner-slider-value" id="trebleValue">0 dB</span>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Stereo</span></div>
                    <div class="tuner-slider-row">
                        <label>Pan</label>
                        <input type="range" id="panSlider" min="-1" max="1" value="0" step="0.01">
                        <span class="tuner-slider-value" id="panValue">C</span>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Compressor</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="compressorToggle">
                        <label for="compressorToggle">Enable Compressor</label>
                    </div>
                    <div class="compressor-panel" id="compressorPanel">
                        <div class="tuner-slider-row">
                            <label>Threshold</label>
                            <input type="range" id="compThreshold" min="-60" max="0" value="-24" step="1">
                            <span class="tuner-slider-value" id="compThresholdVal">-24 dB</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Knee</label>
                            <input type="range" id="compKnee" min="0" max="40" value="30" step="1">
                            <span class="tuner-slider-value" id="compKneeVal">30 dB</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Ratio</label>
                            <input type="range" id="compRatio" min="1" max="20" value="12" step="0.5">
                            <span class="tuner-slider-value" id="compRatioVal">12:1</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Attack</label>
                            <input type="range" id="compAttack" min="0" max="1" value="0.003" step="0.001">
                            <span class="tuner-slider-value" id="compAttackVal">3.0 ms</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Release</label>
                            <input type="range" id="compRelease" min="0.01" max="1" value="0.25" step="0.01">
                            <span class="tuner-slider-value" id="compReleaseVal">250 ms</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Limiter</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="limiterToggle">
                        <label for="limiterToggle">Enable Limiter</label>
                    </div>
                    <div class="compressor-panel" id="limiterPanel">
                        <div class="tuner-slider-row">
                            <label>Threshold</label>
                            <input type="range" id="limThreshold" min="-12" max="0" value="-1" step="0.5">
                            <span class="tuner-slider-value" id="limThresholdVal">-1 dB</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Release</label>
                            <input type="range" id="limRelease" min="0.01" max="0.5" value="0.05" step="0.01">
                            <span class="tuner-slider-value" id="limReleaseVal">50 ms</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Reverb</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="reverbToggle">
                        <label for="reverbToggle">Enable Reverb</label>
                    </div>
                    <div class="compressor-panel" id="reverbPanel">
                        <div class="tuner-slider-row">
                            <label>Mix</label>
                            <input type="range" id="revMix" min="0" max="1" value="0.3" step="0.01">
                            <span class="tuner-slider-value" id="revMixVal">30%</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Decay</label>
                            <input type="range" id="revDecay" min="0.5" max="8" value="2.0" step="0.1">
                            <span class="tuner-slider-value" id="revDecayVal">2.0 s</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Pre-Delay</label>
                            <input type="range" id="revPreDelay" min="0" max="0.1" value="0.01" step="0.001">
                            <span class="tuner-slider-value" id="revPreDelayVal">10 ms</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Delay</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="delayToggle">
                        <label for="delayToggle">Enable Delay</label>
                    </div>
                    <div class="compressor-panel" id="delayPanel">
                        <div class="tuner-slider-row">
                            <label>Time</label>
                            <input type="range" id="delTime" min="0.05" max="2" value="0.3" step="0.01">
                            <span class="tuner-slider-value" id="delTimeVal">300 ms</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Feedback</label>
                            <input type="range" id="delFeedback" min="0" max="0.9" value="0.3" step="0.01">
                            <span class="tuner-slider-value" id="delFeedbackVal">30%</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Mix</label>
                            <input type="range" id="delMix" min="0" max="1" value="0.25" step="0.01">
                            <span class="tuner-slider-value" id="delMixVal">25%</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Crossfeed</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="crossfeedToggle">
                        <label for="crossfeedToggle">Enable Crossfeed</label>
                    </div>
                    <div class="compressor-panel" id="crossfeedPanel">
                        <div class="tuner-slider-row">
                            <label>Level</label>
                            <input type="range" id="cfLevel" min="0" max="0.8" value="0.3" step="0.01">
                            <span class="tuner-slider-value" id="cfLevelVal">30%</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Stereo Widen</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="stereoWidenToggle">
                        <label for="stereoWidenToggle">Enable Stereo Widen</label>
                    </div>
                    <div class="compressor-panel" id="stereoWidenPanel">
                        <div class="tuner-slider-row">
                            <label>Width</label>
                            <input type="range" id="swWidth" min="1" max="3" value="1.3" step="0.1">
                            <span class="tuner-slider-value" id="swWidthVal">1.3x</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="tuner-section-header"><span>Tremolo</span></div>
                    <div class="compressor-toggle-row">
                        <input type="checkbox" id="tremoloToggle">
                        <label for="tremoloToggle">Enable Tremolo</label>
                    </div>
                    <div class="compressor-panel" id="tremoloPanel">
                        <div class="tuner-slider-row">
                            <label>Rate</label>
                            <input type="range" id="tremRate" min="0.5" max="20" value="4.0" step="0.1">
                            <span class="tuner-slider-value" id="tremRateVal">4.0 Hz</span>
                        </div>
                        <div class="tuner-slider-row">
                            <label>Depth</label>
                            <input type="range" id="tremDepth" min="0" max="1" value="0.5" step="0.01">
                            <span class="tuner-slider-value" id="tremDepthVal">50%</span>
                        </div>
                    </div>
                </div>

                <div class="tuner-section">
                    <div class="spectrum-container" style="display:none">
                        <canvas id="spectrumCanvas" width="300" height="48"></canvas>
                    </div>
                    <div class="spectrum-container" style="display:none">
                        <canvas id="oscilloscopeCanvas" width="300" height="48"></canvas>
                    </div>
                </div>
            </div>

            <div class="player-lyrics" id="playerLyrics">
                <div class="player-lyrics-header">
                    <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                    <span>Lyrics</span>
                </div>
                <div class="player-lyrics-content" id="playerLyricsContent">
                    <div class="no-lyrics" id="noLyrics">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                        <p>No lyrics available</p>
                    </div>
                    <div class="lyrics-lines" id="lyricsLines"></div>
                </div>
            </div>
        </div>

        <div class="playlist-container">
            <div class="playlist-header">
                <h3>Playlist</h3>
                <div class="playlist-actions">
                    <button class="action-btn" id="addFolderBtn" title="Add Folder">
                        <svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>
                    </button>
                    <button class="action-btn" id="refreshLibraryBtn" title="Refresh Library">
                        <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.81 2.55-2.98 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                    </button>
                    <button class="action-btn" id="clearPlaylistBtn" title="Clear Playlist">
                        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                    <button class="action-btn" id="reloadExtensionBtn" title="Reload Extension">
                        <svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
                    </button>
                </div>
            </div>
            <div class="search-bar" id="searchBar">
                <input type="text" id="searchInput" placeholder="Search by title, artist, album..." />
                <button class="action-btn" id="clearSearchBtn" title="Clear Search">
                    <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            </div>
            <div class="playlist-tabs">
                <button class="tab active" data-tab="all">All Tracks</button>
                <button class="tab" data-tab="folders">Folders</button>
                <button class="tab" data-tab="queue">Queue</button>
                <button class="tab" data-tab="history">History</button>
                <div class="sort-controls">
                    <select id="sortField" title="Sort by">
                        <option value="random">Random</option>
                        <option value="default">Default</option>
                        <option value="name">Name</option>
                        <option value="dateAdded">Date Added</option>
                        <option value="dateModified">Date Modified</option>
                        <option value="quality">Audio Quality</option>
                        <option value="duration">Duration</option>
                    </select>
                    <button class="sort-dir-btn" id="sortDirBtn" title="Sort Direction">
                        <svg viewBox="0 0 24 24" class="sort-asc"><path d="M7 14l5-5 5 5z"/></svg>
                        <svg viewBox="0 0 24 24" class="sort-desc" style="display:none"><path d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <button class="sort-dir-btn" id="shuffleSortBtn" title="Re-randomize">
                        <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
                    </button>
                </div>
            </div>
            <div class="playlist" id="playlist"></div>
        </div>
    </div>

    <audio id="audioPlayer" preload="auto" crossorigin="anonymous" style="display:none"></audio>

    <script nonce="${nonce}">
        const initialState = ${stateJson};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public refresh() {
        this._postState('playlistChange');
    }

    public dispose() {
        if (this._postTimer) {
            clearTimeout(this._postTimer);
            this._postTimer = null;
        }
        this.playerManager.pause();
        PlayerWebviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    public static disposeCurrent() {
        if (PlayerWebviewPanel.currentPanel) {
            PlayerWebviewPanel.currentPanel.dispose();
        }
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}