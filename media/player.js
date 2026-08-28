(function () {
    const vscode = acquireVsCodeApi();
    let state = initialState || {};
    let currentTab = 'all';
    let searchQuery = '';
    let sortField = 'random';
    let sortAscending = true;
    let randomSortKeys = {};
    let isSeeking = false;
    let isVolumeSeeking = false;
    let lastRenderedTrackCount = 0;
    let lastRenderedTab = '';
    let lastPlayingTrackId = '';
    let lastPlayingState = false;
    let pendingStateUpdate = null;
    let stateUpdateTimer = null;
    let activeContextMenu = null;
    let expectedStartTime = 0;

    let lastAudioUrl = '';
    let isTransitioning = false;
    let needsUserGesture = false;
    let userInitiatedPlay = false;
    let isInternalPause = false;
    let isBackgroundPaused = false;

    let lyricsActiveLineIndex = -1;
    let currentLyrics = null;
    let expandedFolders = {};
    let audioJustEnded = false;
    let isTrackEnding = false;
    let currentTrackGeneration = 0;

    let serverPlayStartTime = 0;
    let serverPlayStartOffset = 0;
    let lastServerTimeSync = 0;
    let clockDrift = 0;
    let rafId = null;
    let lastRafTime = 0;
    let lastTimeReportToServer = 0;
    let audioPlayAttempted = false;
    let audioReadyToPlay = false;
    let suppressAudioEvents = false;
    let lastSeekTime = 0;
    let seekCooldown = false;

    const TIME_REPORT_INTERVAL = 3000;
    const PROGRESS_SYNC_INTERVAL = 1000;
    const SEEK_COOLDOWN_MS = 2000;
    const AUDIO_SEEK_THRESHOLD = 5;
    const TIME_REPORT_THRESHOLD = 5;

    var audioCtx = null;
    var sourceNode = null;
    var analyserNode = null;
    var eqBands = [];
    var lowShelfFilter = null;
    var highShelfFilter = null;
    var highPassFilter = null;
    var lowPassFilter = null;
    var compressorNode = null;
    var stereoPannerNode = null;
    var preGainNode = null;
    var postGainNode = null;
    var audioPipelineConnected = false;

    var EQ_BANDS_CONFIG = [
        { freq: 31, label: '31', type: 'peaking' },
        { freq: 62, label: '62', type: 'peaking' },
        { freq: 125, label: '125', type: 'peaking' },
        { freq: 250, label: '250', type: 'peaking' },
        { freq: 500, label: '500', type: 'peaking' },
        { freq: 1000, label: '1k', type: 'peaking' },
        { freq: 2000, label: '2k', type: 'peaking' },
        { freq: 4000, label: '4k', type: 'peaking' },
        { freq: 8000, label: '8k', type: 'peaking' },
        { freq: 16000, label: '16k', type: 'peaking' }
    ];

    var EQ_PRESETS = {
        flat: { name: 'Flat', gains: [0,0,0,0,0,0,0,0,0,0], bass: 0, treble: 0, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        rock: { name: 'Rock', gains: [5,4,3,1,-1,0,2,4,5,4], bass: 3, treble: 2, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        pop: { name: 'Pop', gains: [-1,2,4,4,2,0,-1,1,2,2], bass: 1, treble: 1, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        jazz: { name: 'Jazz', gains: [3,2,1,2,-1,-1,0,2,3,3], bass: 1, treble: 2, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        classical: { name: 'Classical', gains: [4,3,2,1,-1,-1,0,2,3,4], bass: 0, treble: 2, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        hiphop: { name: 'Hip-Hop', gains: [6,5,4,2,0,0,1,2,3,3], bass: 5, treble: 0, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        vocal: { name: 'Vocal', gains: [-2,-1,0,3,5,5,3,1,0,-1], bass: -2, treble: 2, pan: 0, compressor: { enabled: true, threshold: -18, knee: 12, ratio: 4, attack: 0.003, release: 0.25 } },
        bass: { name: 'Bass Boost', gains: [6,5,4,2,0,0,0,0,0,0], bass: 6, treble: 0, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        treble: { name: 'Treble Boost', gains: [0,0,0,0,0,1,3,5,6,6], bass: 0, treble: 5, pan: 0, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
        electronic: { name: 'Electronic', gains: [5,4,2,0,-1,0,1,4,5,4], bass: 4, treble: 2, pan: 0, compressor: { enabled: true, threshold: -20, knee: 10, ratio: 6, attack: 0.002, release: 0.15 } }
    };

    var tunerState = {
        enabled: false,
        currentPreset: 'flat',
        eqGains: [0,0,0,0,0,0,0,0,0,0],
        bass: 0,
        treble: 0,
        pan: 0,
        compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
        spectrumVisible: false
    };
    var tunerStateSynced = false;

    var spectrumAnimId = null;

    function initAudioPipeline() {
        if (audioPipelineConnected) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            sourceNode = audioCtx.createMediaElementSource(audio);
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 2048;
            analyserNode.smoothingTimeConstant = 0.8;

            preGainNode = audioCtx.createGain();
            preGainNode.gain.value = 1.0;

            eqBands = EQ_BANDS_CONFIG.map(function (cfg) {
                var filter = audioCtx.createBiquadFilter();
                filter.type = cfg.type;
                filter.frequency.value = cfg.freq;
                filter.Q.value = 1.4;
                filter.gain.value = 0;
                return filter;
            });

            lowShelfFilter = audioCtx.createBiquadFilter();
            lowShelfFilter.type = 'lowshelf';
            lowShelfFilter.frequency.value = 200;
            lowShelfFilter.gain.value = 0;

            highShelfFilter = audioCtx.createBiquadFilter();
            highShelfFilter.type = 'highshelf';
            highShelfFilter.frequency.value = 6000;
            highShelfFilter.gain.value = 0;

            highPassFilter = audioCtx.createBiquadFilter();
            highPassFilter.type = 'highpass';
            highPassFilter.frequency.value = 0;
            highPassFilter.Q.value = 0.7;

            lowPassFilter = audioCtx.createBiquadFilter();
            lowPassFilter.type = 'lowpass';
            lowPassFilter.frequency.value = 22050;
            lowPassFilter.Q.value = 0.7;

            compressorNode = audioCtx.createDynamicsCompressor();
            compressorNode.threshold.value = -24;
            compressorNode.knee.value = 30;
            compressorNode.ratio.value = 12;
            compressorNode.attack.value = 0.003;
            compressorNode.release.value = 0.25;

            stereoPannerNode = audioCtx.createStereoPanner();
            stereoPannerNode.pan.value = 0;

            postGainNode = audioCtx.createGain();
            postGainNode.gain.value = 1.0;

            rebuildPipeline();
            audioPipelineConnected = true;
        } catch (e) {
            console.error('Music Radio: Failed to init audio pipeline', e);
        }
    }

    function rebuildPipeline() {
        if (!sourceNode) return;
        try {
            sourceNode.disconnect();
        } catch (e) {}

        var chain = [sourceNode, preGainNode];
        eqBands.forEach(function (band) { chain.push(band); });
        chain.push(lowShelfFilter, highShelfFilter, highPassFilter, lowPassFilter);
        if (tunerState.compressor.enabled) {
            chain.push(compressorNode);
        }
        chain.push(stereoPannerNode, postGainNode, analyserNode, audioCtx.destination);

        for (var i = 0; i < chain.length - 1; i++) {
            try { chain[i].disconnect(); } catch (e) {}
        }
        for (var i = 0; i < chain.length - 1; i++) {
            chain[i].connect(chain[i + 1]);
        }
    }

    function applyTunerState() {
        if (!audioPipelineConnected) return;

        eqBands.forEach(function (band, i) {
            band.gain.value = tunerState.eqGains[i];
        });

        lowShelfFilter.gain.value = tunerState.bass;
        highShelfFilter.gain.value = tunerState.treble;
        stereoPannerNode.pan.value = tunerState.pan;

        if (tunerState.compressor.enabled) {
            compressorNode.threshold.value = tunerState.compressor.threshold;
            compressorNode.knee.value = tunerState.compressor.knee;
            compressorNode.ratio.value = tunerState.compressor.ratio;
            compressorNode.attack.value = tunerState.compressor.attack;
            compressorNode.release.value = tunerState.compressor.release;
        }

        rebuildPipeline();
        renderTunerUI();
        drawEQCurve();
    }

    function applyPreset(presetName) {
        var preset = EQ_PRESETS[presetName];
        if (!preset) return;
        tunerState.currentPreset = presetName;
        tunerState.eqGains = preset.gains.slice();
        tunerState.bass = preset.bass;
        tunerState.treble = preset.treble;
        tunerState.pan = preset.pan;
        tunerState.compressor = Object.assign({}, preset.compressor);
        applyTunerState();
        vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
    }

    function startSpectrumVisualization() {
        if (!analyserNode || !tunerState.spectrumVisible) return;
        var canvas = document.getElementById('spectrumCanvas');
        if (!canvas) return;
        var container = canvas.parentElement;
        if (container) {
            var rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                canvas.width = Math.round(rect.width * (window.devicePixelRatio || 1));
                canvas.height = Math.round(rect.height * (window.devicePixelRatio || 1));
            }
        }
        var ctx = canvas.getContext('2d');
        var bufferLength = analyserNode.frequencyBinCount;
        var dataArray = new Uint8Array(bufferLength);

        function draw() {
            if (!tunerState.spectrumVisible) return;
            spectrumAnimId = requestAnimationFrame(draw);
            analyserNode.getByteFrequencyData(dataArray);

            var w = canvas.width;
            var h = canvas.height;
            ctx.clearRect(0, 0, w, h);

            var barCount = 64;
            var step = Math.floor(bufferLength / barCount);
            var barWidth = w / barCount;
            var accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#007acc';

            for (var i = 0; i < barCount; i++) {
                var val = 0;
                for (var j = 0; j < step; j++) {
                    val += dataArray[i * step + j];
                }
                val = val / step;
                var barHeight = (val / 255) * h;
                var ratio = i / barCount;
                ctx.fillStyle = accentColor;
                ctx.globalAlpha = 0.4 + ratio * 0.6;
                ctx.fillRect(i * barWidth + 1, h - barHeight, barWidth - 2, barHeight);
            }
            ctx.globalAlpha = 1;
        }
        draw();
    }

    function stopSpectrumVisualization() {
        if (spectrumAnimId) {
            cancelAnimationFrame(spectrumAnimId);
            spectrumAnimId = null;
        }
        var canvas = document.getElementById('spectrumCanvas');
        if (canvas) {
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    function drawEQCurve() {
        var canvas = document.getElementById('eqCurveCanvas');
        if (!canvas) return;
        var container = canvas.parentElement;
        if (container) {
            var rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                canvas.width = Math.round(rect.width * (window.devicePixelRatio || 1));
                canvas.height = Math.round(rect.height * (window.devicePixelRatio || 1));
            }
        }
        var ctx = canvas.getContext('2d');
        var w = canvas.width;
        var h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        var midY = h / 2;
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#333';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(w, midY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#007acc';
        ctx.lineWidth = 2;
        ctx.beginPath();

        var freqs = [];
        for (var i = 0; i < w; i++) {
            freqs.push(20 * Math.pow(1000, i / w));
        }

        for (var px = 0; px < w; px++) {
            var freq = freqs[px];
            var totalGain = 0;

            for (var b = 0; b < eqBands.length; b++) {
                var f0 = EQ_BANDS_CONFIG[b].freq;
                var gain = tunerState.eqGains[b];
                var Q = 1.4;
                var x = (freq * freq - f0 * f0) / (freq * Q);
                var denom = 1 + x * x;
                var mag = Math.sqrt(1 + (gain / 20 * (2 + gain / 20)) * x * x / denom);
                var dbGain = 20 * Math.log10(mag);
                totalGain += dbGain;
            }

            if (freq <= 200) {
                totalGain += tunerState.bass * (1 - freq / 200);
            }
            if (freq >= 6000) {
                totalGain += tunerState.treble * ((freq - 6000) / (20000 - 6000));
            }

            var y = midY - (totalGain / 24) * midY;
            y = Math.max(2, Math.min(h - 2, y));
            if (px === 0) {
                ctx.moveTo(px, y);
            } else {
                ctx.lineTo(px, y);
            }
        }
        ctx.stroke();

        var dotRadius = 4;
        var accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#007acc';
        for (var b = 0; b < EQ_BANDS_CONFIG.length; b++) {
            var f0 = EQ_BANDS_CONFIG[b].freq;
            var logPos = Math.log10(f0 / 20) / Math.log10(1000);
            var px = logPos * w;
            var gain = tunerState.eqGains[b];
            var y = midY - (gain / 24) * midY;
            y = Math.max(2, Math.min(h - 2, y));
            ctx.fillStyle = accentColor;
            ctx.beginPath();
            ctx.arc(px, y, dotRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim() || '#1e1e1e';
            ctx.beginPath();
            ctx.arc(px, y, dotRadius - 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function renderTunerUI() {
        var panel = document.getElementById('tunerPanel');
        if (!panel) return;

        var presetSelect = document.getElementById('eqPresetSelect');
        if (presetSelect) presetSelect.value = tunerState.currentPreset;

        var sliders = panel.querySelectorAll('.eq-slider');
        sliders.forEach(function (slider, i) {
            if (i < tunerState.eqGains.length) {
                slider.value = tunerState.eqGains[i];
                var valEl = slider.parentElement.querySelector('.eq-value');
                if (valEl) {
                    var v = tunerState.eqGains[i];
                    valEl.textContent = (v > 0 ? '+' : '') + v + ' dB';
                }
            }
        });

        var bassSlider = document.getElementById('bassSlider');
        if (bassSlider) {
            bassSlider.value = tunerState.bass;
            var bassVal = document.getElementById('bassValue');
            if (bassVal) bassVal.textContent = (tunerState.bass > 0 ? '+' : '') + tunerState.bass + ' dB';
        }

        var trebleSlider = document.getElementById('trebleSlider');
        if (trebleSlider) {
            trebleSlider.value = tunerState.treble;
            var trebleVal = document.getElementById('trebleValue');
            if (trebleVal) trebleVal.textContent = (tunerState.treble > 0 ? '+' : '') + tunerState.treble + ' dB';
        }

        var panSlider = document.getElementById('panSlider');
        if (panSlider) {
            panSlider.value = tunerState.pan;
            var panVal = document.getElementById('panValue');
            if (panVal) {
                if (tunerState.pan === 0) panVal.textContent = 'C';
                else if (tunerState.pan < 0) panVal.textContent = 'L ' + Math.abs(Math.round(tunerState.pan * 100)) + '%';
                else panVal.textContent = 'R ' + Math.round(tunerState.pan * 100) + '%';
            }
        }

        var compToggle = document.getElementById('compressorToggle');
        if (compToggle) compToggle.checked = tunerState.compressor.enabled;

        var compPanel = document.getElementById('compressorPanel');
        if (compPanel) compPanel.style.display = tunerState.compressor.enabled ? 'block' : 'none';

        if (tunerState.compressor.enabled) {
            var compSliders = {
                compThreshold: { el: document.getElementById('compThreshold'), val: document.getElementById('compThresholdVal'), fmt: function(v) { return v + ' dB'; } },
                compKnee: { el: document.getElementById('compKnee'), val: document.getElementById('compKneeVal'), fmt: function(v) { return v + ' dB'; } },
                compRatio: { el: document.getElementById('compRatio'), val: document.getElementById('compRatioVal'), fmt: function(v) { return v + ':1'; } },
                compAttack: { el: document.getElementById('compAttack'), val: document.getElementById('compAttackVal'), fmt: function(v) { return (v * 1000).toFixed(1) + ' ms'; } },
                compRelease: { el: document.getElementById('compRelease'), val: document.getElementById('compReleaseVal'), fmt: function(v) { return (v * 1000).toFixed(0) + ' ms'; } }
            };
            if (compSliders.compThreshold.el) compSliders.compThreshold.el.value = tunerState.compressor.threshold;
            if (compSliders.compThreshold.val) compSliders.compThreshold.val.textContent = compSliders.compThreshold.fmt(tunerState.compressor.threshold);
            if (compSliders.compKnee.el) compSliders.compKnee.el.value = tunerState.compressor.knee;
            if (compSliders.compKnee.val) compSliders.compKnee.val.textContent = compSliders.compKnee.fmt(tunerState.compressor.knee);
            if (compSliders.compRatio.el) compSliders.compRatio.el.value = tunerState.compressor.ratio;
            if (compSliders.compRatio.val) compSliders.compRatio.val.textContent = compSliders.compRatio.fmt(tunerState.compressor.ratio);
            if (compSliders.compAttack.el) compSliders.compAttack.el.value = tunerState.compressor.attack;
            if (compSliders.compAttack.val) compSliders.compAttack.val.textContent = compSliders.compAttack.fmt(tunerState.compressor.attack);
            if (compSliders.compRelease.el) compSliders.compRelease.el.value = tunerState.compressor.release;
            if (compSliders.compRelease.val) compSliders.compRelease.val.textContent = compSliders.compRelease.fmt(tunerState.compressor.release);
        }
    }

    const playBtn = document.getElementById('playBtn');
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const shuffleBtn = document.getElementById('shuffleBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const progressThumb = document.getElementById('progressThumb');
    const currentTimeEl = document.getElementById('currentTime');
    const totalTimeEl = document.getElementById('totalTime');
    const volumeBar = document.getElementById('volumeBar');
    const volumeFill = document.getElementById('volumeFill');
    const volumeValue = document.getElementById('volumeValue');
    const trackTitle = document.getElementById('trackTitle');
    const trackArtist = document.getElementById('trackArtist');
    const trackAlbum = document.getElementById('trackAlbum');
    const albumArt = document.getElementById('albumArt');
    const playlist = document.getElementById('playlist');
    const addFolderBtn = document.getElementById('addFolderBtn');
    const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
    const clearPlaylistBtn = document.getElementById('clearPlaylistBtn');
    const reloadExtensionBtn = document.getElementById('reloadExtensionBtn');
    const searchBar = document.getElementById('searchBar');
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const sortFieldSelect = document.getElementById('sortField');
    const sortDirBtn = document.getElementById('sortDirBtn');
    const shuffleSortBtn = document.getElementById('shuffleSortBtn');
    const audio = document.getElementById('audioPlayer');

    const noLyricsEl = document.getElementById('noLyrics');
    const lyricsLinesEl = document.getElementById('lyricsLines');

    audio.volume = (state.volume || 80) / 100;

    if (state.serverPlayStartTime) {
        serverPlayStartTime = state.serverPlayStartTime;
        serverPlayStartOffset = state.serverPlayStartOffset || 0;
        if (state.serverTime) {
            clockDrift = state.serverTime - Date.now();
        }
    }

    function generateRandomSortKeys() {
        randomSortKeys = {};
        var items = state.playlist || [];
        items.forEach(function (track) {
            randomSortKeys[track.id] = Math.random();
        });
    }

    generateRandomSortKeys();

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function getServerNow() {
        return Date.now() + clockDrift;
    }

    function getEstimatedTime() {
        if (!state.isPlaying || !state.currentTrack) {
            return state.currentTime || 0;
        }
        if (isBackgroundPaused) {
            return state.currentTime || 0;
        }
        var serverElapsed = (getServerNow() - serverPlayStartTime) / 1000;
        return serverPlayStartOffset + serverElapsed;
    }

    function syncServerClock(stateObj) {
        if (stateObj.serverTime) {
            clockDrift = stateObj.serverTime - Date.now();
        }
        if (stateObj.serverPlayStartTime) {
            serverPlayStartTime = stateObj.serverPlayStartTime;
            serverPlayStartOffset = stateObj.serverPlayStartOffset || 0;
        }
        lastServerTimeSync = Date.now();
    }

    function startProgressLoop() {
        stopProgressLoop();
        lastRafTime = performance.now();
        function tick(now) {
            if (!state.isPlaying || isBackgroundPaused) {
                rafId = requestAnimationFrame(tick);
                return;
            }
            if (!isSeeking) {
                var estimated = getEstimatedTime();
                var duration = state.duration || audio.duration || 0;
                if (duration > 0) {
                    updateProgressUI(Math.min(estimated, duration), duration);
                }
                updateLyricsActiveLine(estimated);
            }
            if (now - lastTimeReportToServer > TIME_REPORT_INTERVAL) {
                lastTimeReportToServer = now;
                reportTimeToServer();
            }
            rafId = requestAnimationFrame(tick);
        }
        rafId = requestAnimationFrame(tick);
    }

    function stopProgressLoop() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    function reportTimeToServer() {
        if (seekCooldown) { return; }
        if (!audio.paused && audio.duration && isFinite(audio.currentTime) && audio.currentTime > 0) {
            var audioTime = audio.currentTime;
            var serverTime = getEstimatedTime();
            var diff = Math.abs(audioTime - serverTime);
            if (diff > TIME_REPORT_THRESHOLD) {
                vscode.postMessage({ command: 'timeUpdate', time: audioTime });
            }
        }
    }

    function loadAudio(url, shouldPlay) {
        if (url && url !== lastAudioUrl) {
            lastAudioUrl = url;
            suppressAudioEvents = true;
            isInternalPause = true;
            audio.pause();
            audio.removeAttribute('src');
            audio.src = url;
            audio.load();
            audioJustEnded = false;
            audioPlayAttempted = false;
            audioReadyToPlay = false;
            isTrackEnding = false;
            currentTrackGeneration = (state.trackGeneration || 0);
            setTimeout(function () {
                suppressAudioEvents = false;
                tryBeginPlayback();
            }, 500);
            if (shouldPlay) {
                isTransitioning = true;
            }
        } else if (url && url === lastAudioUrl) {
            if (shouldPlay && audio.paused) {
                if (audio.readyState >= 2) {
                    isTransitioning = false;
                    startAudioPlayback();
                } else {
                    audio.load();
                    isTransitioning = true;
                }
            } else if (!shouldPlay && !audio.paused) {
                pauseAudioPlayback();
            }
        }
    }

    function startAudioPlayback() {
        audioPlayAttempted = true;
        var playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.then(function () {
                isTransitioning = false;
                isTrackEnding = false;
                needsUserGesture = false;
            }).catch(function (e) {
                if (e.name === 'NotAllowedError') {
                    needsUserGesture = true;
                    isTransitioning = false;
                } else {
                    console.error('Audio play failed:', e);
                    isTransitioning = false;
                    vscode.postMessage({ command: 'playbackFailed' });
                }
            });
        }
    }

    function pauseAudioPlayback() {
        isInternalPause = true;
        audio.pause();
    }

    function tryBeginPlayback() {
        if (!isTransitioning || !state.isPlaying) {
            return;
        }
        if (audio.readyState < 2) {
            return;
        }
        if (expectedStartTime > 0 && Math.abs(audio.currentTime - expectedStartTime) > 1) {
            audio.currentTime = expectedStartTime;
            expectedStartTime = 0;
        }
        isTransitioning = false;
        startAudioPlayback();
        reportDuration();
        if (audio.duration && isFinite(audio.currentTime)) {
            serverPlayStartTime = getServerNow();
            serverPlayStartOffset = audio.currentTime;
        }
    }

    function reportDuration() {
        if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
            vscode.postMessage({ command: 'durationUpdate', duration: audio.duration });
        }
    }

    audio.addEventListener('ended', function () {
        if (suppressAudioEvents) return;
        if (isTrackEnding) return;
        var gen = state.trackGeneration || 0;
        if (gen !== currentTrackGeneration && currentTrackGeneration > 0) {
            return;
        }
        isTransitioning = true;
        audioJustEnded = true;
        isTrackEnding = true;
        vscode.postMessage({ command: 'trackEnded' });
    });

    audio.addEventListener('canplay', function () {
        audioReadyToPlay = true;
        tryBeginPlayback();
    });

    audio.addEventListener('loadeddata', function () {
        tryBeginPlayback();
    });

    audio.addEventListener('error', function () {
        if (suppressAudioEvents) return;
        console.error('Audio error:', audio.error);
        isTransitioning = false;
        vscode.postMessage({ command: 'audioError', error: audio.error ? audio.error.message : 'unknown' });
    });

    audio.addEventListener('loadedmetadata', function () {
        if (suppressAudioEvents) return;
        reportDuration();
    });

    audio.addEventListener('durationchange', function () {
        if (suppressAudioEvents) return;
        reportDuration();
    });

    audio.addEventListener('timeupdate', function () {
        if (suppressAudioEvents || isSeeking || seekCooldown) return;
        if (!audio.paused && audio.currentTime > 0 && isFinite(audio.currentTime)) {
            var serverEst = getEstimatedTime();
            var diff = Math.abs(audio.currentTime - serverEst);
            if (diff > TIME_REPORT_THRESHOLD && !isBackgroundPaused) {
                serverPlayStartTime = getServerNow();
                serverPlayStartOffset = audio.currentTime;
            }
        }
    });

    audio.addEventListener('pause', function () {
        if (suppressAudioEvents) return;
        if (audioJustEnded) {
            isInternalPause = false;
            return;
        }
        if (isTrackEnding) {
            isInternalPause = false;
            return;
        }
        if (document.hidden && !isInternalPause && state.isPlaying) {
            isBackgroundPaused = true;
            isInternalPause = false;
            vscode.postMessage({ command: 'backgroundPause' });
            return;
        }
        if (!isInternalPause && state.isPlaying && !document.hidden) {
            setTimeout(function () {
                if (isTrackEnding || audioJustEnded) return;
                if (document.hidden && !isBackgroundPaused && state.isPlaying) {
                    isBackgroundPaused = true;
                    vscode.postMessage({ command: 'backgroundPause' });
                } else if (!document.hidden && !isInternalPause && state.isPlaying && audio.paused) {
                    vscode.postMessage({ command: 'pause' });
                }
            }, 150);
        }
        isInternalPause = false;
    });

    audio.addEventListener('waiting', function () {
    });

    audio.addEventListener('playing', function () {
        if (suppressAudioEvents) return;
        isTransitioning = false;
        isTrackEnding = false;
        needsUserGesture = false;
        isBackgroundPaused = false;
        if (audio.duration && isFinite(audio.currentTime)) {
            serverPlayStartTime = getServerNow();
            serverPlayStartOffset = audio.currentTime;
        }
    });

    function setupMediaSession() {
        if (!('mediaSession' in navigator)) {
            return;
        }

        navigator.mediaSession.setActionHandler('play', function () {
            vscode.postMessage({ command: 'resume' });
        });

        navigator.mediaSession.setActionHandler('pause', function () {
            vscode.postMessage({ command: 'pause' });
        });

        navigator.mediaSession.setActionHandler('nexttrack', function () {
            vscode.postMessage({ command: 'next' });
        });

        navigator.mediaSession.setActionHandler('previoustrack', function () {
            vscode.postMessage({ command: 'previous' });
        });
    }

    function updateMediaSessionMetadata() {
        if (!('mediaSession' in navigator)) {
            return;
        }

        var track = state.currentTrack;
        if (track) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.title || 'Unknown',
                    artist: track.artist || 'Unknown',
                    album: track.album || 'Unknown',
                });
            } catch (e) {
            }
        }

        try {
            navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
        } catch (e) {
        }
    }

    document.addEventListener('click', function () {
        if (needsUserGesture && state.isPlaying && audio.paused) {
            needsUserGesture = false;
            isTransitioning = true;
            startAudioPlayback();
        }
    }, true);

    function resumePlaybackIfNeeded() {
        if (state.isPlaying && audio.paused) {
            audioJustEnded = false;
            var targetUrl = state.audioUrl || lastAudioUrl;
            if (!targetUrl) { return; }
            if (state.audioUrl && state.audioUrl !== lastAudioUrl) {
                lastAudioUrl = state.audioUrl;
                suppressAudioEvents = true;
                isInternalPause = true;
                audio.pause();
                audio.removeAttribute('src');
                audio.src = state.audioUrl;
                audio.load();
                isTransitioning = true;
                suppressAudioEvents = false;
            } else if (audio.src && state.audioUrl && decodeURIComponent(audio.src).indexOf(decodeURIComponent(state.audioUrl)) === -1) {
                lastAudioUrl = state.audioUrl;
                suppressAudioEvents = true;
                isInternalPause = true;
                audio.pause();
                audio.removeAttribute('src');
                audio.src = state.audioUrl;
                audio.load();
                isTransitioning = true;
                suppressAudioEvents = false;
            } else {
                needsUserGesture = false;
                isTransitioning = true;
                if (audio.readyState >= 2) {
                    isTransitioning = false;
                    startAudioPlayback();
                } else {
                    audio.load();
                }
            }
        }
    }

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            var estimated = getEstimatedTime();
            var duration = state.duration || audio.duration || 0;
            if (duration > 0 && estimated > duration) {
                estimated = Math.min(estimated, duration - 0.5);
            }
            if (duration > 0 && !isSeeking) {
                updateProgressUI(Math.min(estimated, duration), duration);
            }
            updateLyricsActiveLine(estimated);

            if (isBackgroundPaused && state.isPlaying) {
                isBackgroundPaused = false;
                vscode.postMessage({ command: 'backgroundResume', time: estimated });
            }
            if (state.isPlaying) {
                serverPlayStartTime = getServerNow();
                serverPlayStartOffset = estimated;
            }
            resumePlaybackIfNeeded();

            setTimeout(function () {
                var est = getEstimatedTime();
                var dur = state.duration || audio.duration || 0;
                if (dur > 0 && est > dur) {
                    est = Math.min(est, dur - 0.5);
                }
                if (dur > 0 && !isSeeking) {
                    updateProgressUI(Math.min(est, dur), dur);
                }
                resumePlaybackIfNeeded();
            }, 150);
            setTimeout(function () {
                syncProgressFromServer();
            }, 800);
        } else {
            if (state.isPlaying && !audio.paused) {
                isBackgroundPaused = true;
                vscode.postMessage({ command: 'backgroundPause' });
            }
        }
    });

    function syncProgressFromServer() {
        var estimated = getEstimatedTime();
        var duration = state.duration || audio.duration || 0;
        if (duration > 0) {
            if (!isSeeking) {
                updateProgressUI(Math.min(estimated, duration), duration);
            }
            updateLyricsActiveLine(estimated);
        }
        if (!audio.paused && audio.duration && isFinite(audio.currentTime)) {
            var diff = Math.abs(audio.currentTime - estimated);
            if (diff > AUDIO_SEEK_THRESHOLD && !isTrackEnding && !seekCooldown) {
                lastSeekTime = Date.now();
                seekCooldown = true;
                audio.currentTime = Math.min(estimated, audio.duration);
                setTimeout(function () {
                    seekCooldown = false;
                }, SEEK_COOLDOWN_MS);
            }
        }
    }

    function updateProgressUI(currentTime, duration) {
        if (!isSeeking && duration > 0 && isFinite(duration) && isFinite(currentTime)) {
            var clampedTime = Math.min(Math.max(currentTime, 0), duration);
            const progress = Math.min((clampedTime / duration) * 100, 100);
            progressFill.style.width = progress + '%';
            progressThumb.style.left = progress + '%';
            currentTimeEl.textContent = formatTime(clampedTime);
        }
        if (isFinite(duration) && duration > 0) {
            totalTimeEl.textContent = formatTime(duration);
        }
    }

    function updatePlayerInfo() {
        const track = state.currentTrack;

        if (track) {
            trackTitle.textContent = track.title || 'Unknown';
            trackArtist.textContent = track.artist || '-';
            trackAlbum.textContent = track.album || '-';

            if (track.albumArt) {
                albumArt.innerHTML = '<img src="' + track.albumArt + '" alt="album art">';
            } else {
                albumArt.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
            }
        } else {
            trackTitle.textContent = 'No track selected';
            trackArtist.textContent = '-';
            trackAlbum.textContent = '-';
            albumArt.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
        }

        if (state.isPlaying) {
            playIcon.style.display = 'none';
            pauseIcon.style.display = 'block';
        } else {
            playIcon.style.display = 'block';
            pauseIcon.style.display = 'none';
        }

        if (!isVolumeSeeking) {
            volumeFill.style.width = state.volume + '%';
            volumeValue.textContent = state.volume + '%';
        }

        shuffleBtn.classList.toggle('active', state.shuffle);
        repeatBtn.classList.toggle('active', state.repeat !== 'none');
        shuffleSortBtn.classList.toggle('active', sortField === 'random');

        if (state.repeat === 'one') {
            repeatBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" text-anchor="middle" font-size="8" fill="currentColor">1</text></svg>';
        } else {
            repeatBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
        }
    }

    function renderLyrics() {
        var lyrics = state.lyrics;
        currentLyrics = lyrics;

        if (!lyrics || !lyrics.lines || lyrics.lines.length === 0) {
            noLyricsEl.style.display = 'flex';
            lyricsLinesEl.style.display = 'none';
            lyricsLinesEl.innerHTML = '';
            return;
        }

        noLyricsEl.style.display = 'none';
        lyricsLinesEl.style.display = 'block';

        var html = '';
        lyrics.lines.forEach(function (line, index) {
            html += '<div class="lyric-line" data-index="' + index + '" data-time="' + line.time + '">';
            html += escapeHtml(line.text);
            if (line.translation) {
                html += '<div class="lyric-translation">' + escapeHtml(line.translation) + '</div>';
            }
            html += '</div>';
        });

        lyricsLinesEl.innerHTML = html;

        lyricsLinesEl.querySelectorAll('.lyric-line').forEach(function (el) {
            el.addEventListener('click', function () {
                var time = parseFloat(el.dataset.time);
                vscode.postMessage({ command: 'seekLyrics', time: time });
            });
        });

        lyricsActiveLineIndex = -1;
        updateLyricsActiveLine(getEstimatedTime());
    }

    function updateLyricsActiveLine(time) {
        if (!currentLyrics || !currentLyrics.lines || currentLyrics.lines.length === 0) {
            return;
        }

        var newActiveIndex = -1;
        for (var i = currentLyrics.lines.length - 1; i >= 0; i--) {
            if (time >= currentLyrics.lines[i].time) {
                newActiveIndex = i;
                break;
            }
        }

        if (newActiveIndex === lyricsActiveLineIndex) {
            return;
        }

        lyricsActiveLineIndex = newActiveIndex;

        var lines = lyricsLinesEl.querySelectorAll('.lyric-line');
        lines.forEach(function (el, index) {
            el.classList.remove('active', 'nearby');
            if (index === lyricsActiveLineIndex) {
                el.classList.add('active');
            } else if (Math.abs(index - lyricsActiveLineIndex) <= 2) {
                el.classList.add('nearby');
            }
        });

        if (lyricsActiveLineIndex >= 0 && lines[lyricsActiveLineIndex]) {
            lines[lyricsActiveLineIndex].scrollIntoView({
                behavior: 'smooth',
                block: 'center',
            });
        }
    }

    function needsFullRerender() {
        const items = getFilteredAndSortedItems();
        const currentPlayingId = state.currentTrack ? state.currentTrack.id : '';
        const currentPlayingState = state.isPlaying;

        if (currentTab !== lastRenderedTab) return true;
        if (items.length !== lastRenderedTrackCount) return true;
        if (currentPlayingId !== lastPlayingTrackId) return true;
        if (currentPlayingState !== lastPlayingState) return true;

        return false;
    }

    var FORMAT_QUALITY = {
        'flac': 80,
        'wav': 70,
        'aiff': 70,
        'm4a': 50,
        'aac': 50,
        'ogg': 40,
        'opus': 40,
        'mp3': 30,
        'wma': 20,
        'mp4': 30,
    };

    function getQualityScore(track) {
        var score = 0;
        var fmt = (track.format || '').toLowerCase();
        score += FORMAT_QUALITY[fmt] || 10;
        if (track.sampleRate) {
            score += track.sampleRate / 1000;
        }
        if (track.bitDepth) {
            score += track.bitDepth;
        }
        if (track.bitrate) {
            score += track.bitrate / 10000;
        }
        return score;
    }

    function getFilteredAndSortedItems() {
        var items;
        if (currentTab === 'all') {
            items = state.playlist || [];
        } else if (currentTab === 'queue') {
            items = state.queue || [];
        } else if (currentTab === 'history') {
            items = state.history || [];
        } else if (currentTab === 'folders') {
            items = state.playlist || [];
        } else {
            items = [];
        }

        if (searchQuery) {
            var lowerQuery = searchQuery.toLowerCase().trim();
            var queryWords = lowerQuery.split(/\s+/).filter(function (w) { return w.length > 0; });
            items = items.filter(function (track) {
                var titleLower = (track.title || '').toLowerCase();
                var artistLower = (track.artist || '').toLowerCase();
                var albumLower = (track.album || '').toLowerCase();
                var fileLower = (track.fileName || '').toLowerCase();
                if (titleLower.includes(lowerQuery) || artistLower.includes(lowerQuery) || albumLower.includes(lowerQuery) || fileLower.includes(lowerQuery)) {
                    return true;
                }
                for (var i = 0; i < queryWords.length; i++) {
                    var w = queryWords[i];
                    if (titleLower.includes(w) || artistLower.includes(w) || albumLower.includes(w) || fileLower.includes(w)) {
                        return true;
                    }
                }
                return false;
            });
        }

        if (currentTab === 'folders') {
            return items;
        }

        if (currentTab === 'history') {
            if (!sortAscending) {
                items = items.slice().reverse();
            }
            return items;
        }

        if (sortField === 'random') {
            var sorted = items.slice();
            sorted.sort(function (a, b) {
                var keyA = randomSortKeys[a.id];
                var keyB = randomSortKeys[b.id];
                if (keyA === undefined) {
                    randomSortKeys[a.id] = Math.random();
                    keyA = randomSortKeys[a.id];
                }
                if (keyB === undefined) {
                    randomSortKeys[b.id] = Math.random();
                    keyB = randomSortKeys[b.id];
                }
                return keyA - keyB;
            });
            items = sorted;
        } else if (sortField !== 'default') {
            var sorted = items.slice();
            sorted.sort(function (a, b) {
                var cmp = 0;
                switch (sortField) {
                    case 'name':
                        cmp = (a.title || '').localeCompare(b.title || '');
                        break;
                    case 'dateAdded':
                        cmp = ((a.dateAdded || 0) - (b.dateAdded || 0));
                        break;
                    case 'dateModified':
                        cmp = ((a.dateModified || 0) - (b.dateModified || 0));
                        break;
                    case 'quality':
                        cmp = (getQualityScore(a) - getQualityScore(b));
                        break;
                    case 'duration':
                        cmp = ((a.duration || 0) - (b.duration || 0));
                        break;
                    default:
                        cmp = 0;
                }
                return sortAscending ? cmp : -cmp;
            });
            items = sorted;
        }

        return items;
    }

    function renderPlaylist() {
        if (currentTab === 'folders') {
            renderFoldersView();
            lastRenderedTab = currentTab;
            return;
        }

        const items = getFilteredAndSortedItems();
        const currentPlayingId = state.currentTrack ? state.currentTrack.id : '';

        if (!needsFullRerender()) {
            return;
        }

        lastRenderedTrackCount = items.length;
        lastRenderedTab = currentTab;
        lastPlayingTrackId = currentPlayingId;
        lastPlayingState = state.isPlaying;

        if (items.length === 0) {
            var msg, hint;
            if (searchQuery) {
                msg = 'No results for "' + escapeHtml(searchQuery) + '"';
                hint = 'Try a different search term';
            } else if (currentTab === 'all') {
                msg = 'No tracks in library';
                hint = 'Add a music folder to get started';
            } else if (currentTab === 'history') {
                msg = 'History is empty';
                hint = 'Played tracks will appear here';
            } else {
                msg = 'Queue is empty';
                hint = 'Right-click a track to add to queue';
            }
            playlist.innerHTML = '<div class="playlist-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg><p>' + msg + '</p><p class="hint">' + hint + '</p></div>';
            return;
        }

        let html = '';
        items.forEach(function (track, index) {
            const isPlaying = currentPlayingId === track.id;

            html += '<div class="playlist-item' + (isPlaying ? ' playing' : '') + '" data-track-id="' + track.id + '" data-index="' + index + '">';
            html += '<div class="item-index">';
            if (isPlaying && state.isPlaying) {
                html += '<div class="playing-indicator"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>';
            } else {
                html += (index + 1);
            }
            html += '</div>';
            html += '<div class="item-info">';
            html += '<div class="item-title">' + escapeHtml(track.title) + '</div>';
            var metaParts = [];
            if (track.artist && track.artist !== 'Unknown') {
                metaParts.push(escapeHtml(track.artist));
            }
            if (track.format) {
                metaParts.push('<span class="item-format">' + escapeHtml(track.format.toUpperCase()) + '</span>');
            }
            if (track.sampleRate && track.sampleRate >= 44100) {
                var sr = track.sampleRate >= 1000 ? (track.sampleRate / 1000).toFixed(1).replace(/\.0$/, '') + 'kHz' : track.sampleRate + 'Hz';
                metaParts.push(sr);
            }
            if (track.bitDepth) {
                metaParts.push(track.bitDepth + 'bit');
            }
            if (metaParts.length > 0) {
                html += '<div class="item-artist">' + metaParts.join(' · ') + '</div>';
            }
            html += '</div>';
            if (track.duration > 0) {
                html += '<div class="item-duration">' + formatTime(track.duration) + '</div>';
            }
            html += '<div class="item-actions">';
            html += '<button class="item-action-btn" data-action="playNext" data-track-id="' + track.id + '" title="Play Next"><svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg></button>';
            html += '<button class="item-action-btn" data-action="addToQueue" data-track-id="' + track.id + '" title="Add to Queue"><svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button>';
            html += '</div>';
            html += '</div>';
        });

        playlist.innerHTML = html;

        playlist.querySelectorAll('.playlist-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target.closest('.item-action-btn')) return;
                const trackId = item.dataset.trackId;
                vscode.postMessage({ command: 'playTrack', trackId: trackId });
            });

            item.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const trackId = item.dataset.trackId;
                const renderedIndex = parseInt(item.dataset.index, 10);
                const track = findTrackById(trackId);
                if (track) {
                    showContextMenu(e.clientX, e.clientY, track, currentTab, renderedIndex);
                }
            });
        });

        playlist.querySelectorAll('.item-action-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                const action = btn.dataset.action;
                const trackId = btn.dataset.trackId;
                vscode.postMessage({ command: action, trackId: trackId });
            });
        });
    }

    function renderFoldersView() {
        var folders = state.musicFolders || [];
        var allTracks = state.playlist || [];
        var currentPlayingId = state.currentTrack ? state.currentTrack.id : '';

        if (folders.length === 0) {
            playlist.innerHTML = '<div class="playlist-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg><p>No folders added</p><p class="hint">Click + to add a music folder</p></div>';
            return;
        }

        var html = '';

        folders.forEach(function (folderPath) {
            var folderName = folderPath.split(/[/\\]/).pop();
            var folderTracks = allTracks.filter(function (t) { return t.filePath.startsWith(folderPath); });
            var isExpanded = expandedFolders[folderPath] !== false;
            var filteredTracks = folderTracks;

            if (searchQuery) {
                var lowerQuery = searchQuery.toLowerCase().trim();
                var queryWords = lowerQuery.split(/\s+/).filter(function (w) { return w.length > 0; });
                filteredTracks = folderTracks.filter(function (track) {
                    var titleLower = (track.title || '').toLowerCase();
                    var artistLower = (track.artist || '').toLowerCase();
                    var albumLower = (track.album || '').toLowerCase();
                    var fileLower = (track.fileName || '').toLowerCase();
                    if (titleLower.includes(lowerQuery) || artistLower.includes(lowerQuery) || albumLower.includes(lowerQuery) || fileLower.includes(lowerQuery)) {
                        return true;
                    }
                    for (var i = 0; i < queryWords.length; i++) {
                        var w = queryWords[i];
                        if (titleLower.includes(w) || artistLower.includes(w) || albumLower.includes(w) || fileLower.includes(w)) {
                            return true;
                        }
                    }
                    return false;
                });
            }

            html += '<div class="folder-group">';
            html += '<div class="folder-header" data-folder-path="' + escapeHtml(folderPath) + '">';
            html += '<svg class="folder-chevron' + (isExpanded ? ' expanded' : '') + '" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';
            html += '<svg class="folder-icon" viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2z"/></svg>';
            html += '<span class="folder-name">' + escapeHtml(folderName) + '</span>';
            html += '<span class="folder-count">(' + folderTracks.length + ')</span>';
            html += '<div class="folder-actions">';
            html += '<button class="folder-action-btn" data-action="reloadFolder" data-folder-path="' + escapeHtml(folderPath) + '" title="Reload Folder"><svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.81 2.55-2.98 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>';
            html += '<button class="folder-action-btn" data-action="removeFolder" data-folder-path="' + escapeHtml(folderPath) + '" title="Remove Folder"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>';
            html += '</div>';
            html += '</div>';

            if (isExpanded) {
                html += '<div class="folder-tracks">';
                if (filteredTracks.length === 0) {
                    if (searchQuery) {
                        html += '<div class="folder-empty">No matching tracks</div>';
                    } else {
                        html += '<div class="folder-empty">No music files found</div>';
                    }
                } else {
                    filteredTracks.forEach(function (track, index) {
                        var isPlaying = currentPlayingId === track.id;
                        html += '<div class="playlist-item' + (isPlaying ? ' playing' : '') + '" data-track-id="' + track.id + '" data-index="' + index + '">';
                        html += '<div class="item-index">';
                        if (isPlaying && state.isPlaying) {
                            html += '<div class="playing-indicator"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>';
                        } else {
                            html += (index + 1);
                        }
                        html += '</div>';
                        html += '<div class="item-info">';
                        html += '<div class="item-title">' + escapeHtml(track.title) + '</div>';
                        var metaParts = [];
                        if (track.artist && track.artist !== 'Unknown') {
                            metaParts.push(escapeHtml(track.artist));
                        }
                        if (track.format) {
                            metaParts.push('<span class="item-format">' + escapeHtml(track.format.toUpperCase()) + '</span>');
                        }
                        if (metaParts.length > 0) {
                            html += '<div class="item-artist">' + metaParts.join(' · ') + '</div>';
                        }
                        html += '</div>';
                        if (track.duration > 0) {
                            html += '<div class="item-duration">' + formatTime(track.duration) + '</div>';
                        }
                        html += '<div class="item-actions">';
                        html += '<button class="item-action-btn" data-action="playNext" data-track-id="' + track.id + '" title="Play Next"><svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg></button>';
                        html += '<button class="item-action-btn" data-action="addToQueue" data-track-id="' + track.id + '" title="Add to Queue"><svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button>';
                        html += '</div>';
                        html += '</div>';
                    });
                }
                html += '</div>';
            }

            html += '</div>';
        });

        playlist.innerHTML = html;

        playlist.querySelectorAll('.folder-header').forEach(function (header) {
            header.addEventListener('click', function (e) {
                if (e.target.closest('.folder-action-btn')) return;
                var folderPath = header.dataset.folderPath;
                expandedFolders[folderPath] = expandedFolders[folderPath] === false ? true : false;
                lastRenderedTab = '';
                renderPlaylist();
            });
        });

        playlist.querySelectorAll('.folder-action-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var action = btn.dataset.action;
                var folderPath = btn.dataset.folderPath;
                if (action === 'removeFolder') {
                    vscode.postMessage({ command: 'removeFolder', folderPath: folderPath });
                } else if (action === 'reloadFolder') {
                    vscode.postMessage({ command: 'reloadFolder', folderPath: folderPath });
                }
            });
        });

        playlist.querySelectorAll('.playlist-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target.closest('.item-action-btn')) return;
                var trackId = item.dataset.trackId;
                vscode.postMessage({ command: 'playTrack', trackId: trackId });
            });

            item.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var trackId = item.dataset.trackId;
                var track = findTrackById(trackId);
                if (track) {
                    showContextMenu(e.clientX, e.clientY, track, 'folders');
                }
            });
        });

        playlist.querySelectorAll('.item-action-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var action = btn.dataset.action;
                var trackId = btn.dataset.trackId;
                vscode.postMessage({ command: action, trackId: trackId });
            });
        });
    }

    function findTrackById(trackId) {
        const allTracks = state.playlist || [];
        const queueTracks = state.queue || [];
        const historyTracks = state.history || [];
        return allTracks.find(function (t) { return t.id === trackId; })
            || queueTracks.find(function (t) { return t.id === trackId; })
            || historyTracks.find(function (t) { return t.id === trackId; });
    }

    function closeContextMenu() {
        if (activeContextMenu) {
            activeContextMenu.remove();
            activeContextMenu = null;
        }
    }

    function showContextMenu(x, y, track, source, renderedIndex) {
        closeContextMenu();

        var menu = document.createElement('div');
        menu.className = 'context-menu';

        var playIcon = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
        var playNextIcon = '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
        var addToQueueIcon = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
        var removeIcon = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
        var revealIcon = '<svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-1.5.7-1.5 1.5l-.01 11c0 .83.67 1.5 1.5 1.5h16c.83 0 1.5-.67 1.5-1.5v-9c0-.83-.67-1.5-1.5-1.5zm0 11H4V8h16v9z"/></svg>';
        var copyIcon = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';

        var menuItems = [];

        menuItems.push({
            label: 'Play',
            icon: playIcon,
            action: function () { vscode.postMessage({ command: 'playTrack', trackId: track.id }); }
        });

        if (source === 'queue') {
            menuItems.push({
                label: 'Move to Top',
                icon: playNextIcon,
                action: function () { vscode.postMessage({ command: 'playNext', trackId: track.id }); }
            });
            menuItems.push({
                label: 'Remove from Queue',
                icon: removeIcon,
                action: function () {
                    var idx = (state.queue || []).findIndex(function (t) { return t.id === track.id; });
                    if (idx >= 0) {
                        vscode.postMessage({ command: 'removeFromQueue', index: idx });
                    }
                }
            });
        } else {
            menuItems.push({
                label: 'Play Next',
                icon: playNextIcon,
                action: function () { vscode.postMessage({ command: 'playNext', trackId: track.id }); }
            });
            menuItems.push({
                label: 'Add to Queue',
                icon: addToQueueIcon,
                action: function () { vscode.postMessage({ command: 'addToQueue', trackId: track.id }); }
            });
            if (source === 'history') {
                menuItems.push({
                    label: 'Remove from History',
                    icon: removeIcon,
                    action: function () {
                        if (renderedIndex !== undefined && renderedIndex >= 0) {
                            var historyIndex = renderedIndex;
                            if (!sortAscending) {
                                historyIndex = (state.history || []).length - 1 - renderedIndex;
                            }
                            vscode.postMessage({ command: 'removeFromHistory', index: historyIndex });
                        }
                    }
                });
            }
        }

        menuItems.push({ separator: true });
        menuItems.push({
            label: 'Reveal in File Explorer',
            icon: revealIcon,
            action: function () { vscode.postMessage({ command: 'revealInExplorer', trackId: track.id }); }
        });
        menuItems.push({
            label: 'Copy Absolute Path',
            icon: copyIcon,
            action: function () { vscode.postMessage({ command: 'copyAbsolutePath', trackId: track.id }); }
        });
        menuItems.push({
            label: 'Copy Relative Path',
            icon: copyIcon,
            action: function () { vscode.postMessage({ command: 'copyRelativePath', trackId: track.id }); }
        });

        menuItems.forEach(function (item) {
            if (item.separator) {
                var sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            var el = document.createElement('div');
            el.className = 'context-menu-item';
            el.innerHTML = item.icon + '<span>' + escapeHtml(item.label) + '</span>';
            el.addEventListener('click', function () {
                closeContextMenu();
                item.action();
            });
            menu.appendChild(el);
        });

        document.body.appendChild(menu);
        activeContextMenu = menu;

        var menuRect = menu.getBoundingClientRect();
        var menuWidth = menuRect.width;
        var menuHeight = menuRect.height;
        var finalX = x;
        var finalY = y;
        if (finalX + menuWidth > window.innerWidth) {
            finalX = window.innerWidth - menuWidth - 4;
        }
        if (finalY + menuHeight > window.innerHeight) {
            finalY = window.innerHeight - menuHeight - 4;
        }
        menu.style.left = finalX + 'px';
        menu.style.top = finalY + 'px';
    }

    document.addEventListener('click', function (e) {
        if (activeContextMenu && !activeContextMenu.contains(e.target)) {
            closeContextMenu();
        }
    });

    document.addEventListener('contextmenu', function (e) {
        if (activeContextMenu && !activeContextMenu.contains(e.target)) {
            e.preventDefault();
            closeContextMenu();
        }
    });

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    playBtn.addEventListener('click', function () {
        audioJustEnded = false;
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        if (audio.paused && lastAudioUrl && !state.isPlaying) {
            userInitiatedPlay = true;
            startAudioPlayback();
        }
        vscode.postMessage({ command: 'playPause' });
    });

    nextBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'next' });
    });

    prevBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'previous' });
    });

    shuffleBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'toggleShuffle' });
    });

    repeatBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'toggleRepeat' });
    });

    addFolderBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'addFolder' });
    });

    refreshLibraryBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'scanFolder' });
    });

    clearPlaylistBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'clearPlaylist' });
    });

    reloadExtensionBtn.addEventListener('click', function () {
        vscode.postMessage({ command: 'reloadExtension' });
    });

    var tunerToggleBtn = document.getElementById('tunerToggleBtn');
    if (tunerToggleBtn) {
        tunerToggleBtn.addEventListener('click', function () {
            var panel = document.getElementById('tunerPanel');
            if (!panel) return;
            tunerState.enabled = !tunerState.enabled;
            panel.style.display = tunerState.enabled ? 'flex' : 'none';
            tunerToggleBtn.classList.toggle('active', tunerState.enabled);
            if (tunerState.enabled) {
                if (!audioPipelineConnected) {
                    initAudioPipeline();
                    if (audioPipelineConnected) {
                        applyTunerState();
                    }
                }
                drawEQCurve();
                if (tunerState.spectrumVisible) {
                    startSpectrumVisualization();
                }
            }
        });
    }

    var eqPresetSelect = document.getElementById('eqPresetSelect');
    if (eqPresetSelect) {
        eqPresetSelect.addEventListener('change', function () {
            if (!audioPipelineConnected) {
                initAudioPipeline();
            }
            applyPreset(eqPresetSelect.value);
        });
    }

    document.querySelectorAll('.eq-slider').forEach(function (slider, i) {
        slider.addEventListener('input', function () {
            if (!audioPipelineConnected) {
                initAudioPipeline();
            }
            tunerState.eqGains[i] = parseInt(slider.value, 10);
            var valEl = slider.parentElement.querySelector('.eq-value');
            if (valEl) {
                var v = tunerState.eqGains[i];
                valEl.textContent = (v > 0 ? '+' : '') + v + ' dB';
            }
            if (audioPipelineConnected) {
                eqBands[i].gain.value = tunerState.eqGains[i];
            }
            drawEQCurve();
        });
        slider.addEventListener('change', function () {
            tunerState.currentPreset = 'custom';
            var presetSelect = document.getElementById('eqPresetSelect');
            if (presetSelect) presetSelect.value = 'custom';
            vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
        });
    });

    var bassSlider = document.getElementById('bassSlider');
    if (bassSlider) {
        bassSlider.addEventListener('input', function () {
            if (!audioPipelineConnected) { initAudioPipeline(); }
            tunerState.bass = parseInt(bassSlider.value, 10);
            var bassVal = document.getElementById('bassValue');
            if (bassVal) bassVal.textContent = (tunerState.bass > 0 ? '+' : '') + tunerState.bass + ' dB';
            if (audioPipelineConnected) lowShelfFilter.gain.value = tunerState.bass;
            drawEQCurve();
        });
        bassSlider.addEventListener('change', function () {
            tunerState.currentPreset = 'custom';
            var ps = document.getElementById('eqPresetSelect');
            if (ps) ps.value = 'custom';
            vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
        });
    }

    var trebleSlider = document.getElementById('trebleSlider');
    if (trebleSlider) {
        trebleSlider.addEventListener('input', function () {
            if (!audioPipelineConnected) { initAudioPipeline(); }
            tunerState.treble = parseInt(trebleSlider.value, 10);
            var trebleVal = document.getElementById('trebleValue');
            if (trebleVal) trebleVal.textContent = (tunerState.treble > 0 ? '+' : '') + tunerState.treble + ' dB';
            if (audioPipelineConnected) highShelfFilter.gain.value = tunerState.treble;
            drawEQCurve();
        });
        trebleSlider.addEventListener('change', function () {
            tunerState.currentPreset = 'custom';
            var ps = document.getElementById('eqPresetSelect');
            if (ps) ps.value = 'custom';
            vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
        });
    }

    var panSlider = document.getElementById('panSlider');
    if (panSlider) {
        panSlider.addEventListener('input', function () {
            if (!audioPipelineConnected) { initAudioPipeline(); }
            tunerState.pan = parseFloat(panSlider.value);
            var panVal = document.getElementById('panValue');
            if (panVal) {
                if (tunerState.pan === 0) panVal.textContent = 'C';
                else if (tunerState.pan < 0) panVal.textContent = 'L ' + Math.abs(Math.round(tunerState.pan * 100)) + '%';
                else panVal.textContent = 'R ' + Math.round(tunerState.pan * 100) + '%';
            }
            if (audioPipelineConnected) stereoPannerNode.pan.value = tunerState.pan;
        });
        panSlider.addEventListener('change', function () {
            vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
        });
    }

    var compressorToggle = document.getElementById('compressorToggle');
    if (compressorToggle) {
        compressorToggle.addEventListener('change', function () {
            if (!audioPipelineConnected) { initAudioPipeline(); }
            tunerState.compressor.enabled = compressorToggle.checked;
            var compPanel = document.getElementById('compressorPanel');
            if (compPanel) compPanel.style.display = tunerState.compressor.enabled ? 'block' : 'none';
            if (audioPipelineConnected) {
                rebuildPipeline();
            }
            vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
        });
    }

    ['compThreshold', 'compKnee', 'compRatio', 'compAttack', 'compRelease'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', function () {
            if (!audioPipelineConnected) { initAudioPipeline(); }
            var val = parseFloat(el.value);
            switch (id) {
                case 'compThreshold': tunerState.compressor.threshold = val; break;
                case 'compKnee': tunerState.compressor.knee = val; break;
                case 'compRatio': tunerState.compressor.ratio = val; break;
                case 'compAttack': tunerState.compressor.attack = val; break;
                case 'compRelease': tunerState.compressor.release = val; break;
            }
            if (audioPipelineConnected && tunerState.compressor.enabled) {
                switch (id) {
                    case 'compThreshold': compressorNode.threshold.value = val; break;
                    case 'compKnee': compressorNode.knee.value = val; break;
                    case 'compRatio': compressorNode.ratio.value = val; break;
                    case 'compAttack': compressorNode.attack.value = val; break;
                    case 'compRelease': compressorNode.release.value = val; break;
                }
            }
            var valEl = document.getElementById(id + 'Val');
            if (valEl) {
                switch (id) {
                    case 'compThreshold': valEl.textContent = val + ' dB'; break;
                    case 'compKnee': valEl.textContent = val + ' dB'; break;
                    case 'compRatio': valEl.textContent = val + ':1'; break;
                    case 'compAttack': valEl.textContent = (val * 1000).toFixed(1) + ' ms'; break;
                    case 'compRelease': valEl.textContent = (val * 1000).toFixed(0) + ' ms'; break;
                }
            }
        });
        el.addEventListener('change', function () {
            vscode.postMessage({ command: 'saveTunerState', tunerState: tunerState });
        });
    });

    var spectrumToggle = document.getElementById('spectrumToggle');
    if (spectrumToggle) {
        spectrumToggle.addEventListener('click', function () {
            if (!audioPipelineConnected) { initAudioPipeline(); }
            tunerState.spectrumVisible = !tunerState.spectrumVisible;
            spectrumToggle.classList.toggle('active', tunerState.spectrumVisible);
            var canvas = document.getElementById('spectrumCanvas');
            if (canvas) canvas.style.display = tunerState.spectrumVisible ? 'block' : 'none';
            if (tunerState.spectrumVisible) {
                startSpectrumVisualization();
            } else {
                stopSpectrumVisualization();
            }
        });
    }

    var eqResetBtn = document.getElementById('eqResetBtn');
    if (eqResetBtn) {
        eqResetBtn.addEventListener('click', function () {
            applyPreset('flat');
        });
    }

    searchInput.addEventListener('input', function () {
        searchQuery = searchInput.value;
        lastRenderedTab = '';
        renderPlaylist();
    });

    clearSearchBtn.addEventListener('click', function () {
        searchInput.value = '';
        searchQuery = '';
        lastRenderedTab = '';
        renderPlaylist();
        searchInput.focus();
    });

    sortFieldSelect.addEventListener('change', function () {
        sortField = sortFieldSelect.value;
        if (sortField === 'random') {
            generateRandomSortKeys();
        }
        lastRenderedTab = '';
        renderPlaylist();
    });

    sortDirBtn.addEventListener('click', function () {
        sortAscending = !sortAscending;
        var ascIcon = sortDirBtn.querySelector('.sort-asc');
        var descIcon = sortDirBtn.querySelector('.sort-desc');
        if (sortAscending) {
            ascIcon.style.display = '';
            descIcon.style.display = 'none';
        } else {
            ascIcon.style.display = 'none';
            descIcon.style.display = '';
        }
        lastRenderedTab = '';
        renderPlaylist();
    });

    shuffleSortBtn.addEventListener('click', function () {
        if (sortField !== 'random') {
            sortField = 'random';
            sortFieldSelect.value = 'random';
        }
        generateRandomSortKeys();
        lastRenderedTab = '';
        renderPlaylist();
    });

    progressBar.addEventListener('mousedown', function (e) {
        isSeeking = true;
        seekToPosition(e);
    });

    document.addEventListener('mousemove', function (e) {
        if (isSeeking) {
            seekToPosition(e);
        }
        if (isVolumeSeeking) {
            setVolumeFromPosition(e);
        }
    });

    document.addEventListener('mouseup', function () {
        if (isSeeking) {
            isSeeking = false;
            const ratio = parseFloat(progressFill.style.width) / 100;
            const time = ratio * (state.duration || 0);
            if (audio.duration && lastAudioUrl) {
                seekCooldown = true;
                audio.currentTime = time;
                setTimeout(function () { seekCooldown = false; }, SEEK_COOLDOWN_MS);
            }
            vscode.postMessage({ command: 'seek', time: time });
        }
        isVolumeSeeking = false;
    });

    function seekToPosition(e) {
        const rect = progressBar.getBoundingClientRect();
        let ratio = (e.clientX - rect.left) / rect.width;
        ratio = Math.max(0, Math.min(1, ratio));
        const time = ratio * (state.duration || 0);
        progressFill.style.width = (ratio * 100) + '%';
        progressThumb.style.left = (ratio * 100) + '%';
        currentTimeEl.textContent = formatTime(time);
    }

    volumeBar.addEventListener('mousedown', function (e) {
        isVolumeSeeking = true;
        setVolumeFromPosition(e);
    });

    function setVolumeFromPosition(e) {
        const rect = volumeBar.getBoundingClientRect();
        let ratio = (e.clientX - rect.left) / rect.width;
        ratio = Math.max(0, Math.min(1, ratio));
        const vol = Math.round(ratio * 100);
        audio.volume = ratio;
        vscode.postMessage({ command: 'setVolume', volume: vol });
        state.volume = vol;
        volumeFill.style.width = vol + '%';
        volumeValue.textContent = vol + '%';
    }

    document.querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentTab = tab.dataset.tab;
            lastRenderedTab = '';
            renderPlaylist();
        });
    });

    window.addEventListener('message', function (event) {
        const message = event.data;
        if (message.command === 'stateUpdate') {
            pendingStateUpdate = message;
            if (!stateUpdateTimer) {
                stateUpdateTimer = setTimeout(function () {
                    stateUpdateTimer = null;
                    if (pendingStateUpdate) {
                        applyState(pendingStateUpdate);
                        pendingStateUpdate = null;
                    }
                }, 0);
            }
        } else if (message.command === 'panelBecameVisible') {
            if (stateUpdateTimer) {
                clearTimeout(stateUpdateTimer);
                stateUpdateTimer = null;
            }
            if (pendingStateUpdate) {
                applyState(pendingStateUpdate);
                pendingStateUpdate = null;
            }
            setTimeout(function () {
                resumePlaybackIfNeeded();
                var pbvEst = getEstimatedTime();
                var pbvDur = state.duration || audio.duration || 0;
                if (pbvDur > 0 && !isSeeking) {
                    updateProgressUI(Math.min(pbvEst, pbvDur), pbvDur);
                }
                updateLyricsActiveLine(pbvEst);
            }, 100);
        }
    });

    function applyState(message) {
        const oldTrackId = state.currentTrack ? state.currentTrack.id : null;
        const oldIsPlaying = state.isPlaying;
        const oldAudioUrl = state.audioUrl;
        state = message.state;
        syncServerClock(state);

        if (state.tunerState && !tunerStateSynced) {
            var saved = state.tunerState;
            tunerState.currentPreset = saved.currentPreset || 'flat';
            tunerState.eqGains = saved.eqGains ? saved.eqGains.slice() : [0,0,0,0,0,0,0,0,0,0];
            tunerState.bass = saved.bass || 0;
            tunerState.treble = saved.treble || 0;
            tunerState.pan = saved.pan || 0;
            if (saved.compressor) {
                tunerState.compressor = Object.assign({}, tunerState.compressor, saved.compressor);
            }
            tunerStateSynced = true;
            if (audioPipelineConnected) {
                applyTunerState();
            }
            renderTunerUI();
        }

        if (sortField === 'random' && state.playlist) {
            state.playlist.forEach(function (track) {
                if (randomSortKeys[track.id] === undefined) {
                    randomSortKeys[track.id] = Math.random();
                }
            });
        }
        const newTrackId = state.currentTrack ? state.currentTrack.id : null;
        const newAudioUrl = state.audioUrl;
        const trackChanged = oldTrackId !== newTrackId;
        const audioUrlChanged = oldAudioUrl !== newAudioUrl;

        if (message.event === 'panelVisible') {
            if (state.audioUrl && state.audioUrl !== lastAudioUrl) {
                loadAudio(state.audioUrl, state.isPlaying);
            } else if (state.isPlaying && audio.paused) {
                needsUserGesture = false;
                if (audio.readyState >= 2) {
                    isTransitioning = false;
                    startAudioPlayback();
                } else if (state.audioUrl) {
                    isTransitioning = true;
                    audio.load();
                }
            } else if (!state.isPlaying && !audio.paused) {
                pauseAudioPlayback();
            }
            var pvEst = getEstimatedTime();
            var pvDur = state.duration || audio.duration || 0;
            if (pvDur > 0 && !isSeeking) {
                updateProgressUI(Math.min(pvEst, pvDur), pvDur);
            }
            updateLyricsActiveLine(pvEst);
        } else if (trackChanged || audioUrlChanged) {
            audioJustEnded = false;
            isTrackEnding = false;
            if (state.audioUrl) {
                loadAudio(state.audioUrl, state.isPlaying);
            } else {
                lastAudioUrl = '';
                isInternalPause = true;
                audio.pause();
                audio.removeAttribute('src');
            }
            expectedStartTime = state.currentTime || 0;
            seekCooldown = true;
            setTimeout(function () { seekCooldown = false; }, SEEK_COOLDOWN_MS);
            syncProgressFromServer();
        } else if (message.event === 'stateChange') {
            if (state.isPlaying && !oldIsPlaying) {
                if (userInitiatedPlay) {
                    userInitiatedPlay = false;
                } else if (audio.paused && lastAudioUrl) {
                    if (needsUserGesture) {
                    } else if (audio.readyState >= 2) {
                        isTransitioning = false;
                        startAudioPlayback();
                    } else {
                        isTransitioning = true;
                        audio.load();
                    }
                }
            } else if (!state.isPlaying && oldIsPlaying) {
                if (!audio.paused) {
                    pauseAudioPlayback();
                }
            }
            var scEst = getEstimatedTime();
            var scDur = state.duration || audio.duration || 0;
            if (scDur > 0 && !isSeeking) {
                updateProgressUI(Math.min(scEst, scDur), scDur);
            }
            updateLyricsActiveLine(scEst);
        } else if (message.event === 'seek') {
            if (audio.duration && lastAudioUrl) {
                seekCooldown = true;
                audio.currentTime = state.currentTime;
                setTimeout(function () {
                    seekCooldown = false;
                }, SEEK_COOLDOWN_MS);
            }
            var seekEst = getEstimatedTime();
            var seekDur = state.duration || audio.duration || 0;
            if (seekDur > 0 && !isSeeking) {
                updateProgressUI(Math.min(seekEst, seekDur), seekDur);
            }
        } else if (message.event === 'timeUpdate') {
            if (audio.paused || isBackgroundPaused) {
                var est = getEstimatedTime();
                var dur = state.duration || audio.duration || 0;
                if (dur > 0 && !isSeeking) {
                    updateProgressUI(Math.min(est, dur), dur);
                }
            } else if (!isSeeking) {
                var est2 = getEstimatedTime();
                var dur2 = state.duration || audio.duration || 0;
                if (dur2 > 0) {
                    updateProgressUI(Math.min(est2, dur2), dur2);
                }
            }
            updateLyricsActiveLine(getEstimatedTime());
        } else if (message.event === 'volumeChange') {
            if (!isVolumeSeeking) {
                audio.volume = (state.volume || 80) / 100;
            }
        }

        updatePlayerInfo();
        renderPlaylist();
        updateMediaSessionMetadata();

        if (trackChanged || message.event === 'lyricsUpdate') {
            renderLyrics();
        }

        if (state.isPlaying && !rafId) {
            startProgressLoop();
        } else if (!state.isPlaying && rafId) {
            stopProgressLoop();
        }
    }

    updatePlayerInfo();
    renderPlaylist();
    renderLyrics();

    if (state.audioUrl) {
        lastAudioUrl = state.audioUrl;
        audio.src = state.audioUrl;
        audio.load();
        if (state.isPlaying) {
            isTransitioning = true;
        }
        if (!state.isPlaying && state.currentTime > 0) {
            audio.addEventListener('loadedmetadata', function onInitialSeek() {
                audio.removeEventListener('loadedmetadata', onInitialSeek);
                if (audio.duration && state.currentTime <= audio.duration) {
                    seekCooldown = true;
                    audio.currentTime = state.currentTime;
                    setTimeout(function () { seekCooldown = false; }, SEEK_COOLDOWN_MS);
                    var initEst = getEstimatedTime();
                    var initDur = state.duration || audio.duration || 0;
                    if (initDur > 0 && !isSeeking) {
                        updateProgressUI(Math.min(initEst, initDur), initDur);
                    }
                }
            });
        }
    }

    if (state.isPlaying) {
        startProgressLoop();
    }

    setupMediaSession();
    updateMediaSessionMetadata();
})();