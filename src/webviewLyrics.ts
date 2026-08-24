import * as vscode from 'vscode';
import { PlayerManager } from './playerManager';

export class LyricsWebviewView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'music-radio-lyrics';
    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];
    private _pendingTrack = false;

    constructor(
        private extensionUri: vscode.Uri,
        private playerManager: PlayerManager,
    ) {
        playerManager.onDidChange((event) => {
            if (!this._view) {
                if (event === 'trackChange') {
                    this._pendingTrack = true;
                }
                return;
            }

            if (event === 'trackChange') {
                this._view.webview.postMessage({
                    command: 'lyricsUpdate',
                    lyrics: this.playerManager.GetLyrics,
                    currentTrack: this.playerManager.getCurrentTrack,
                });
            } else if (event === 'lyricsUpdate') {
                this._view.webview.postMessage({
                    command: 'lyricsUpdate',
                    lyrics: this.playerManager.GetLyrics,
                    currentTrack: this.playerManager.getCurrentTrack,
                });
            } else if (event === 'timeUpdate' || event === 'seek') {
                this._view.webview.postMessage({
                    command: 'timeUpdate',
                    currentTime: this.playerManager.getEstimatedCurrentTime(),
                });
            }
        });
    }

    public get view(): vscode.WebviewView | undefined {
        return this._view;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            (message) => {
                switch (message.command) {
                    case 'seek':
                        this.playerManager.seekTo(message.time);
                        break;
                }
            },
            null,
            this._disposables,
        );

        const state = this.playerManager.getState();
        if (state.currentTrack) {
            this._pendingTrack = false;
            setTimeout(() => {
                if (!this._view) { return; }
                this._view.webview.postMessage({
                    command: 'lyricsUpdate',
                    lyrics: this.playerManager.GetLyrics,
                    currentTrack: state.currentTrack,
                });
                this._view.webview.postMessage({
                    command: 'timeUpdate',
                    currentTime: this.playerManager.getEstimatedCurrentTime(),
                });
            }, 200);
        }

        this._view.webview.onDidReceiveMessage(
            (message) => {
                if (message.command === 'ready') {
                    const currentState = this.playerManager.getState();
                    if (currentState.currentTrack) {
                        this._view?.webview.postMessage({
                            command: 'lyricsUpdate',
                            lyrics: this.playerManager.GetLyrics,
                            currentTrack: currentState.currentTrack,
                        });
                        this._view?.webview.postMessage({
                            command: 'timeUpdate',
                            currentTime: this.playerManager.getEstimatedCurrentTime(),
                        });
                    }
                }
            },
            null,
            this._disposables,
        );
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'lyrics.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'lyrics.css')
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div id="lyrics-container">
        <div class="no-lyrics" id="noLyrics">
            <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
            <p>No lyrics available</p>
            <p class="hint">Play a track with embedded or external lyrics</p>
        </div>
        <div class="lyrics" id="lyrics"></div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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