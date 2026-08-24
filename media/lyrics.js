(function () {
    const vscode = acquireVsCodeApi();
    let currentLyrics = null;
    let currentTime = 0;
    let activeLineIndex = -1;

    const lyricsContainer = document.getElementById('lyrics-container');
    const noLyrics = document.getElementById('noLyrics');
    const lyricsEl = document.getElementById('lyrics');

    function renderLyrics(lyrics) {
        if (!lyrics || !lyrics.lines || lyrics.lines.length === 0) {
            noLyrics.style.display = 'flex';
            lyricsEl.classList.remove('has-lyrics');
            lyricsEl.innerHTML = '';
            return;
        }

        noLyrics.style.display = 'none';
        lyricsEl.classList.add('has-lyrics');

        let html = '<div class="lyrics-header"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>Lyrics</div>';

        lyrics.lines.forEach(function (line, index) {
            html += '<div class="lyric-line" data-index="' + index + '" data-time="' + line.time + '">';
            html += escapeHtml(line.text);
            if (line.translation) {
                html += '<div class="lyric-translation">' + escapeHtml(line.translation) + '</div>';
            }
            html += '</div>';
        });

        lyricsEl.innerHTML = html;

        lyricsEl.querySelectorAll('.lyric-line').forEach(function (el) {
            el.addEventListener('click', function () {
                const time = parseFloat(el.dataset.time);
                vscode.postMessage({ command: 'seek', time: time });
            });
        });

        activeLineIndex = -1;
        updateActiveLine(currentTime);
    }

    function updateActiveLine(time) {
        if (!currentLyrics || !currentLyrics.lines || currentLyrics.lines.length === 0) {
            return;
        }

        let newActiveIndex = -1;
        for (let i = currentLyrics.lines.length - 1; i >= 0; i--) {
            if (time >= currentLyrics.lines[i].time) {
                newActiveIndex = i;
                break;
            }
        }

        if (newActiveIndex === activeLineIndex) {
            return;
        }

        activeLineIndex = newActiveIndex;

        const lines = lyricsEl.querySelectorAll('.lyric-line');
        lines.forEach(function (el, index) {
            el.classList.remove('active', 'nearby');
            if (index === activeLineIndex) {
                el.classList.add('active');
            } else if (Math.abs(index - activeLineIndex) <= 2) {
                el.classList.add('nearby');
            }
        });

        if (activeLineIndex >= 0 && lines[activeLineIndex]) {
            lines[activeLineIndex].scrollIntoView({
                behavior: 'smooth',
                block: 'center',
            });
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    window.addEventListener('message', function (event) {
        const message = event.data;

        if (message.command === 'lyricsUpdate') {
            currentLyrics = message.lyrics;
            activeLineIndex = -1;
            renderLyrics(currentLyrics);
        } else if (message.command === 'timeUpdate') {
            currentTime = message.currentTime;
            updateActiveLine(currentTime);
        }
    });

    vscode.postMessage({ command: 'ready' });
})();