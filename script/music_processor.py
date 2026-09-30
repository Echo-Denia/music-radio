#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Music File Processing Toolkit -- Lyric Recognition, Translation & Embedding Pipeline
====================================================================================

A comprehensive music file processing tool that handles the full pipeline of
audio processing, including: format conversion, vocal separation, speech
recognition, translation, and lyric embedding.

Features
--------
- **Format Conversion**: M4A -> MP3 conversion (320kbps) via ffmpeg
- **MP3 Header Repair**: Automatic detection and repair of corrupted MP3 headers
- **Multi-GPU Support**: DataParallel / model-parallel strategies for acceleration
- **Vocal Separation**: Demucs-based high-quality vocal isolation
- **VAD Smart Segmentation**: pyannote / webrtcvad dual-engine voice activity detection
- **Speech Recognition**: Whisper-based lyric transcription with hallucination fallback
- **Language Detection**: Auto-detect language via Whisper + regex heuristics
- **Translation Engines**:
  - Local NLLB-200 / M2M100 models for offline translation
  - OpenAI-compatible LLM API for context-aware translation
- **Lyric Embedding**: MP3 (ID3v2.3 SYLT+USLT) / FLAC (Vorbis Comments) with chapter navigation
- **Cover Art**: Automatic matching and embedding of album covers
- **Romaji Generation**: Automatic generation of Japanese romaji (romanization)
- **File Integrity**: Detection, directory comparison, MP3-FLAC matching & migration
- **Pure Instrumental Handling**: Auto-detection and tagging of instrumental tracks

Modes Overview
--------------
+------+------------------------------------+------------------------------------------+
| Mode | Name                               | Description                              |
+======+====================================+==========================================+
| 1    | Video -> Audio                     | Convert MP4 video to MP3 audio           |
+------+------------------------------------+------------------------------------------+
| 2    | Process Lyrics                     | Full pipeline: recognition, translation, |
|      |                                    | embed lyrics + cover art                 |
+------+------------------------------------+------------------------------------------+
| 3    | Verify File Integrity              | Check audio file for corruption          |
+------+------------------------------------+------------------------------------------+
| 4    | Merge Audio/Video                  | Combine MP3 audio with MP4 video         |
+------+------------------------------------+------------------------------------------+
| 5    | Compare Directories                | Find missing files between two dirs      |
+------+------------------------------------+------------------------------------------+
| 6    | File Integrity Check               | Check cover art & metadata completeness  |
+------+------------------------------------+------------------------------------------+
| 7    | Japanese -> Romaji                 | Add romaji (romanization) to lyrics      |
+------+------------------------------------+------------------------------------------+
| 8    | View Embedded Lyrics               | Display embedded lyrics in audio file    |
+------+------------------------------------+------------------------------------------+
| 9    | MP3<->FLAC Match & Migrate         | Fuzzy-match MP3 to FLAC, replace old     |
+------+------------------------------------+------------------------------------------+

Configuration
-------------
All sensitive configurations (paths, API keys) should be set via environment
variables or a ``config.yaml`` file. No hardcoded paths or API keys are present.

1. **Environment variables**: Set variables like ``MUSIC_BASE_DIR``,
   ``LLM_API_KEY``, etc. before running.

2. **Config file**: Create a ``config.yaml`` alongside this script with your
   settings. Example::

        mode: 2
        paths:
            base_dir: /path/to/music
            input_paths:
                - /path/to/music/file.flac
        processing:
            whisper_model_size: large-v3

3. **Command-line arguments**: Basic overrides via CLI flags.

Dependencies
------------
See ``environment.yml`` for the full conda environment specification.

License
-------
MIT License
"""

# ============================================================================
# Standard Library Imports
# ============================================================================
import argparse
import gc
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import unicodedata
import locale
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

# ============================================================================
# Third-Party Imports -- Audio / ML
# ============================================================================
import numpy as np
import requests
import torch
import torch.nn as nn
import torchaudio
import webrtcvad
import whisper
import difflib
import yaml

# ============================================================================
# Third-Party Imports -- Metadata / Tagging
# ============================================================================
from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    ID3,
    USLT,
    SYLT,
    Encoding,
    CTOC,
    CTOCFlags,
    CHAP,
    TIT2,
    APIC,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4

# ============================================================================
# Third-Party Imports -- Japanese / Chinese Text Processing
# ============================================================================
from pykakasi import kakasi
from send2trash import send2trash
from tqdm import tqdm
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

# ============================================================================
# Optional Imports -- Demucs (vocal separation)
# ============================================================================
try:
    from demucs import api as demucs_api

    DEMUCS_AVAILABLE = True
except ImportError:
    DEMUCS_AVAILABLE = False

# ============================================================================
# Optional Imports -- pyannote (VAD)
# ============================================================================
try:
    from pyannote.audio.pipelines import VoiceActivityDetection

    PYANNOTE_AVAILABLE = True
except ImportError:
    PYANNOTE_AVAILABLE = False

# ============================================================================
# Logging Configuration
# ============================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ============================================================================
# Default Configuration Template
# ============================================================================
# This dictionary defines ALL configurable parameters with their defaults.
# Users MUST override these via environment variables or a config.yaml file.
# NO hardcoded personal paths or API keys are present.
# ============================================================================
CONFIG_TEMPLATE: Dict[str, Any] = {
    # ---- Mode Selection ----
    # See the module docstring for mode descriptions.
    "mode": 2,
    # ---- Path Configuration ----
    # All paths default to None -- users MUST provide them via env vars or config file.
    "paths": {
        # Base directory for music files (env: MUSIC_BASE_DIR)
        "base_dir": None,
        # Download directory (env: MUSIC_DOWNLOAD_DIR)
        "download_dir": None,
        # Directory for storing models (env: MUSIC_MODELS_DIR)
        "models_dir": None,
        # mode 1/3/4: working directory (defaults to download_dir)
        "work_dir": None,
        # mode 1/3/4: filename without extension
        "work_filename": "",
        # mode 1/3/4: audio format
        "work_audio_format": "mp3",
        # mode 2/7: list of input file/folder paths
        "input_paths": [],
        # mode 5: directory comparison paths
        "compare_dir1": None,
        "compare_dir2": None,
        # mode 6: directory for music file integrity check
        "check_dir": None,
        # mode 8: file path for viewing embedded lyrics
        "lyrics_file": None,
        # mode 9: MP3/FLAC matching & migration paths
        "mp3_folder": None,
        "flac_folder": None,
        "flac_output_folder": None,
        "match_similarity_threshold": 0.5,
    },
    # ---- Multi-GPU Configuration ----
    "gpu": {
        "enabled": True,
        # Strategy: "auto" / "data_parallel" / "model_parallel"
        "strategy": "auto",
        # GPU IDs to use: "all" or list of integers [0, 1, ...]
        "gpu_ids": "all",
        "chunk_size": 4,
    },
    # ---- VAD (Voice Activity Detection) Model ----
    "vad": {
        # Local path for pyannote segmentation model (download if None)
        "local_path": None,
        # HuggingFace mirror endpoint (env: HF_ENDPOINT)
        "hf_mirror": "https://hf-mirror.com",
        "model_name": "pyannote/segmentation",
    },
    # ---- Demucs Vocal Separation ----
    "demucs": {
        "enabled": True,
        "model": "htdemucs_ft",
        "device": "cuda",
        "segment": None,
        "shifts": 5,
        "cleanup_temp": True,
        # Local repository path for Demucs model
        "local_repo": None,
        # HuggingFace endpoint (env: HF_ENDPOINT)
        "hf_endpoint": "https://hf-mirror.com",
    },
    # ---- Translation Model Configurations ----
    "translation_models": {
        "NLLB-200-3.3B": {
            "is_nllb": True,
            "lang_mapping": {
                "ja": "jpn_Jpan",
                "en": "eng_Latn",
                "ko": "kor_Hang",
                "zh": "zho_Hans",
            },
            "tgt_lang": "zho_Hans",
            "chunk_size": 200,
        },
        "M2M100_418M": {
            "is_nllb": False,
            "lang_mapping": {"ja": "ja", "en": "en", "ko": "ko", "zh": "zh"},
            "tgt_lang": "zh",
            "chunk_size": 500,
        },
    },
    # ---- Whisper Model Options ----
    "whisper_models": {
        "tiny": "Fastest, lowest accuracy",
        "base": "Balanced speed and accuracy",
        "small": "Good accuracy, moderate speed",
        "medium": "High accuracy, slower",
        "large": "Highest accuracy, slowest",
        "large-v1": "Large model v1",
        "large-v2": "Large model v2",
        "large-v3": "Large model v3 (latest)",
    },
    # ---- Processing Settings ----
    "processing": {
        # Local path for pyannote VAD pipeline (env: VAD_MODEL_PATH)
        "vad_model_path": None,
        # Local directory for translation model (env: TRANSLATION_MODEL_DIR)
        "local_model_dir": None,
        # Whisper model size (env: WHISPER_MODEL_SIZE)
        "whisper_model_size": "large-v3",
        # Enable VAD for smart segmentation
        "enable_vad": True,
        # Translation mode: "llm" / "line_by_line" / "context"
        "translation_mode": "line_by_line",
        # If True, skip existing lyrics and force re-recognition + translation
        "force_reprocess_lyrics": False,
        # Manually specify language ("zh"/"ja"/"ko"/"en"), None for auto-detect
        "manual_language": None,
        # True=instrumental, False=has lyrics, None=auto-detect
        "manual_is_instrumental": None,
    },
    # ---- LLM Translation API Configuration (OpenAI Compatible) ----
    # Set via environment variables: LLM_API_KEY, LLM_ENDPOINT, LLM_MODEL
    "api": {
        "llm": {
            "api_key": None,
            "endpoint": "http://127.0.0.1:11435/v1/chat/completions",
            "provider": "openai",
            "model": "gpt-3.5-turbo",
            "prompt": (
                "You are a line-by-line lyric translator. Your only task is to "
                "translate user-provided lyrics line by line into Simplified Chinese.\n"
                "Strictly follow these rules:\n"
                "1. Input format: `[timestamp]original lyrics`. Output: "
                "`[same timestamp]Chinese translation`. One-to-one correspondence.\n"
                "2. Same number of lines in and out. Never add, delete, merge, "
                "or split any line.\n"
                "3. Timestamps must be copied verbatim. Do not alter, drop, "
                "or reorder them.\n"
                "4. Translate with the song's overall mood in mind. Keep the "
                "rhythm and emotion. Chinese should sound natural and fluent.\n"
                "5. Output translations only. No explanations, greetings, "
                "questions, or extra text.\n"
            ),
            "response_format": None,
            "timeout": 300,
            "max_tokens": 8000,
            "temperature": 0.7,
        },
    },
    # ---- Cover Art Configuration ----
    "cover": {
        "enabled": True,
        "replace_existing": False,
        "supported_formats": [".jpg", ".jpeg", ".png", ".bmp", ".webp"],
    },
    # ---- Supported Audio Extensions ----
    "audio_extensions": (".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".wma"),
}

# Module-level aliases -- updated after load_config() is called
MULTI_GPU_CONFIG = CONFIG_TEMPLATE["gpu"]
VAD_MODEL_CONFIG = CONFIG_TEMPLATE["vad"]
DEMUCS_CONFIG = CONFIG_TEMPLATE["demucs"]
MODEL_CONFIGS = CONFIG_TEMPLATE["translation_models"]
WHISPER_MODELS = CONFIG_TEMPLATE["whisper_models"]
SUPPORTED_AUDIO_EXTENSIONS = CONFIG_TEMPLATE["audio_extensions"]


# ============================================================================
# Configuration Loading
# ============================================================================

def _env(key: str, default: Optional[str] = None) -> Optional[str]:
    """Get value from environment variable, with fallback to default."""
    return os.environ.get(key, default)


def load_config(config_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Load configuration from environment variables and optional YAML file.

    Priority (highest to lowest):
        1. Environment variables
        2. YAML config file values
        3. CONFIG_TEMPLATE defaults

    Parameters
    ----------
    config_path : str or None
        Path to a YAML configuration file. If None, looks for ``config.yaml``
        in the script's directory.

    Returns
    -------
    dict
        Merged configuration dictionary.
    """
    import copy

    config = copy.deepcopy(CONFIG_TEMPLATE)

    # Step 1: Load YAML config file (if any)
    yaml_config = {}
    yaml_paths = []
    if config_path:
        yaml_paths.append(config_path)
    else:
        script_dir = Path(__file__).resolve().parent
        yaml_paths.append(str(script_dir / "config.yaml"))
        yaml_paths.append(str(Path.cwd() / "config.yaml"))

    for yp in yaml_paths:
        if yp and os.path.isfile(yp):
            try:
                with open(yp, "r", encoding="utf-8") as f:
                    loaded = yaml.safe_load(f) or {}
                yaml_config = loaded
                logger.info(f"Loaded config from: {yp}")
                break
            except Exception as e:
                logger.warning(f"Failed to load config from {yp}: {e}")

    def _deep_merge(base: dict, override: dict) -> None:
        """Recursively merge override dict into base dict in-place."""
        for key, value in override.items():
            if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                _deep_merge(base[key], value)
            else:
                base[key] = value

    _deep_merge(config, yaml_config)

    # Step 2: Override with environment variables
    paths = config["paths"]
    _maybe_set(paths, "base_dir", _env("MUSIC_BASE_DIR"))
    _maybe_set(paths, "download_dir", _env("MUSIC_DOWNLOAD_DIR"))
    _maybe_set(paths, "models_dir", _env("MUSIC_MODELS_DIR"))

    processing = config["processing"]
    _maybe_set(processing, "vad_model_path", _env("VAD_MODEL_PATH"))
    _maybe_set(processing, "local_model_dir", _env("TRANSLATION_MODEL_DIR"))
    _maybe_set(processing, "whisper_model_size", _env("WHISPER_MODEL_SIZE"))
    _maybe_set(processing, "translation_mode", _env("TRANSLATION_MODE"))

    llm = config["api"]["llm"]
    _maybe_set(llm, "api_key", _env("LLM_API_KEY"))
    _maybe_set(llm, "endpoint", _env("LLM_ENDPOINT"))
    _maybe_set(llm, "model", _env("LLM_MODEL"))

    vad_cfg = config["vad"]
    _maybe_set(vad_cfg, "local_path", _env("VAD_LOCAL_PATH"))

    demucs_cfg = config["demucs"]
    _maybe_set(demucs_cfg, "local_repo", _env("DEMUCS_LOCAL_REPO"))

    # Update module-level aliases
    global MULTI_GPU_CONFIG, VAD_MODEL_CONFIG, DEMUCS_CONFIG, MODEL_CONFIGS
    global WHISPER_MODELS, SUPPORTED_AUDIO_EXTENSIONS
    MULTI_GPU_CONFIG = config["gpu"]
    VAD_MODEL_CONFIG = config["vad"]
    DEMUCS_CONFIG = config["demucs"]
    MODEL_CONFIGS = config["translation_models"]
    WHISPER_MODELS = config["whisper_models"]
    SUPPORTED_AUDIO_EXTENSIONS = config["audio_extensions"]

    # Set HF_ENDPOINT if configured
    hf_endpoint = demucs_cfg.get("hf_endpoint") or vad_cfg.get("hf_mirror")
    if hf_endpoint:
        os.environ.setdefault("HF_ENDPOINT", hf_endpoint)

    return config


def _maybe_set(dct: dict, key: str, value: Optional[str]) -> None:
    """Set dictionary key to value if value is not None or empty string."""
    if value is not None and value != "":
        dct[key] = value


# ============================================================================
# Device / GPU Utilities
# ============================================================================


def get_device() -> str:
    """Get the best available device for computation ("cuda" or "cpu")."""
    return "cuda" if torch.cuda.is_available() else "cpu"


def cleanup_gpu() -> None:
    """Clean up GPU memory cache and run garbage collection."""
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()


# ============================================================================
# Multi-GPU Manager
# ============================================================================


class MultiGPUManager:
    """
    Detects available GPUs and coordinates model loading strategies.

    Supports three parallelization strategies:
    - ``"data_parallel"``: Uses ``torch.nn.DataParallel`` to replicate
      the model across all GPUs. Best for batch processing.
    - ``"model_parallel"``: Splits encoder and decoder across different
      GPUs. Best for large translation models.
    - ``"auto"``: Automatically selects the best strategy based on GPU count.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        cfg: Dict[str, Any] = config or MULTI_GPU_CONFIG
        self.enabled: bool = cfg.get("enabled", True)
        self.strategy: str = cfg.get("strategy", "auto")
        self.gpu_ids_cfg: Any = cfg.get("gpu_ids", "all")
        self.available_gpus: List[int] = self._detect()

    def _detect(self) -> List[int]:
        """Detect available CUDA GPUs and return their IDs."""
        if not torch.cuda.is_available():
            logger.warning("CUDA not available, will use CPU")
            return []

        count = torch.cuda.device_count()
        logger.info(f"Detected {count} GPU(s)")
        for i in range(count):
            name = torch.cuda.get_device_name(i)
            mem = torch.cuda.get_device_properties(i).total_memory / 1024 ** 3
            logger.info(f"  GPU {i}: {name} ({mem:.1f} GB)")

        if self.gpu_ids_cfg == "all":
            ids = list(range(count))
        else:
            ids = list(self.gpu_ids_cfg)

        valid = [i for i in ids if i < count]
        if not valid:
            logger.warning("No usable GPU found, will use CPU")
            return []
        logger.info(f"Using GPU(s): {valid}")
        return valid

    @property
    def device(self) -> str:
        """Get the primary GPU device string."""
        return f"cuda:{self.available_gpus[0]}" if self.available_gpus else "cpu"

    def setup_model(self, model: nn.Module, model_type: str = "translation") -> nn.Module:
        """
        Assign GPU strategy for a model.

        Parameters
        ----------
        model : torch.nn.Module
            The model to distribute.
        model_type : str
            Type of model: ``"translation"`` or ``"whisper"``.

        Returns
        -------
        torch.nn.Module
            The model with appropriate GPU strategy applied.
        """
        if not self.available_gpus or not self.enabled:
            return model.to(self.device)

        if len(self.available_gpus) == 1:
            return model.to(self.device)

        if self.strategy == "data_parallel":
            logger.info(f"Using DataParallel on GPUs: {self.available_gpus}")
            return nn.DataParallel(model, device_ids=self.available_gpus)

        return self._model_parallel(model, model_type)

    def _model_parallel(self, model: nn.Module, model_type: str) -> nn.Module:
        """Apply model-parallel distribution (encoder/decoder split across GPUs)."""
        gpu_count = len(self.available_gpus)
        if gpu_count < 2:
            return model.to(self.device)

        try:
            if model_type == "whisper":
                device = f"cuda:{self.available_gpus[0]}"
                model = model.to(device)
                for attr in ("encoder", "decoder"):
                    if hasattr(model, attr) and getattr(model, attr) is not None:
                        setattr(model, attr, getattr(model, attr).to(device))
                logger.info(f"Whisper model assigned to: {device}")
            elif model_type == "translation":
                if hasattr(model, "encoder"):
                    model.encoder = model.encoder.to(f"cuda:{self.available_gpus[0]}")
                if hasattr(model, "decoder") and gpu_count >= 2:
                    model.decoder = model.decoder.to(f"cuda:{self.available_gpus[1]}")
            return model
        except Exception as e:
            logger.warning(f"Model-parallel setup failed: {e}, falling back to DataParallel")
            return nn.DataParallel(model, device_ids=self.available_gpus)


# Global GPU manager instance (lazy-initialized)
_gpu_manager: Optional[MultiGPUManager] = None


def _get_gpu_manager() -> MultiGPUManager:
    """Get or initialize the global GPU manager."""
    global _gpu_manager
    if _gpu_manager is None:
        _gpu_manager = MultiGPUManager()
    return _gpu_manager


def setup_multi_gpu(config: Optional[Dict[str, Any]] = None) -> MultiGPUManager:
    """Initialize or re-configure the global GPU manager."""
    global _gpu_manager
    if config:
        _gpu_manager = MultiGPUManager(config)
    elif _gpu_manager is None:
        _gpu_manager = MultiGPUManager()
    return _gpu_manager


# ============================================================================
# M4A -> MP3 Conversion
# ============================================================================


def convert_m4a_to_mp3(m4a_path: str) -> Tuple[bool, str, Optional[str]]:
    """
    Convert an .m4a file to .mp3 (320kbps) using ffmpeg.

    The original .m4a file is deleted after successful conversion.

    Returns
    -------
    tuple
        ``(success: bool, output_path: str, error_message: str or None)``
    """
    if not os.path.exists(m4a_path):
        return False, m4a_path, "File not found"

    temp_dir = tempfile.mkdtemp(prefix="m4a_to_mp3_")
    mp3_filename = os.path.splitext(os.path.basename(m4a_path))[0] + ".mp3"
    temp_mp3_path = os.path.join(temp_dir, mp3_filename)

    try:
        cmd = [
            "ffmpeg", "-i", m4a_path, "-y",
            "-codec:a", "libmp3lame", "-b:a", "320k", temp_mp3_path,
        ]
        logger.info(f"Converting: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            return False, m4a_path, f"ffmpeg failed: {result.stderr}"
        final_path = os.path.join(os.path.dirname(m4a_path), mp3_filename)
        shutil.move(temp_mp3_path, final_path)
        os.remove(m4a_path)
        logger.info(f"M4A conversion successful: {final_path}")
        return True, final_path, None
    except subprocess.TimeoutExpired:
        return False, m4a_path, "Conversion timed out"
    except Exception as e:
        return False, m4a_path, f"Conversion error: {e}"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def process_m4a_files(audio_files: List[str]) -> List[str]:
    """Convert all .m4a files in a list to .mp3. Skips if MP3 already exists."""
    processed: List[str] = []
    converted: List[Tuple[str, str]] = []

    for f in audio_files:
        if not f.lower().endswith(".m4a"):
            processed.append(f)
            continue
        mp3_path = os.path.splitext(f)[0] + ".mp3"
        if os.path.exists(mp3_path):
            logger.info(f"Corresponding MP3 already exists, skipping: {mp3_path}")
            processed.append(mp3_path)
            continue
        ok, new_path, err = convert_m4a_to_mp3(f)
        if ok:
            processed.append(new_path)
            converted.append((f, new_path))
        else:
            logger.error(f"M4A conversion failed: {f}, {err}")
            processed.append(f)

    if converted:
        logger.info(f"M4A conversion complete: {len(converted)} file(s)")
    return processed


# ============================================================================
# MP3 Header Repair
# ============================================================================


def repair_mp3_file(audio_path: str) -> Tuple[bool, str, Optional[str]]:
    """
    Re-encapsulate an MP3 file with ffmpeg to repair corrupted headers.

    A backup is kept during the repair process and restored on failure.

    Returns
    -------
    tuple
        ``(success: bool, path: str, error: str or None)``
    """
    if not os.path.exists(audio_path):
        return False, audio_path, "File not found"

    temp_dir = tempfile.mkdtemp(prefix="mp3_repair_")
    backup_path = os.path.join(temp_dir, os.path.basename(audio_path))
    repaired_path = os.path.join(temp_dir, "repaired_" + os.path.basename(audio_path))

    try:
        shutil.copy2(audio_path, backup_path)
        result = subprocess.run(
            ["ffmpeg", "-i", audio_path, "-y", repaired_path],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            shutil.move(backup_path, audio_path)
            return False, audio_path, f"ffmpeg repair failed: {result.stderr}"
        shutil.move(repaired_path, audio_path)
        logger.info(f"MP3 repair successful: {audio_path}")
        return True, audio_path, None
    except subprocess.TimeoutExpired:
        if os.path.exists(backup_path):
            shutil.move(backup_path, audio_path)
        return False, audio_path, "Repair timed out"
    except Exception as e:
        if os.path.exists(backup_path):
            shutil.move(backup_path, audio_path)
        return False, audio_path, f"Repair error: {e}"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ============================================================================
# Timestamp Parsing Utilities (reused throughout)
# ============================================================================

_TIMESTAMP_PATTERN_DOT = re.compile(r"\[(\d+):(\d+)\.(\d+)\](.*)")  # [mm:ss.mmm]
_TIMESTAMP_PATTERN_COLON = re.compile(r"\[(\d+):(\d+):(\d+)\](.*)")  # [mm:ss:mmm]


def _parse_timestamp_line(line: str) -> Optional[Tuple[int, str]]:
    """
    Parse a single LRC-style timestamp line.

    Supports both ``[mm:ss.mmm]`` and ``[mm:ss:mmm]`` formats.

    Returns
    -------
    tuple or None
        ``(timestamp_ms: int, text: str)`` or None if no timestamp found.
    """
    for pat in (_TIMESTAMP_PATTERN_DOT, _TIMESTAMP_PATTERN_COLON):
        m = pat.match(line.strip())
        if m:
            mins, secs, frac, text = m.groups()
            ms = int(frac)
            if len(frac) == 2:
                ms *= 10
            ts = (int(mins) * 60 + int(secs)) * 1000 + ms
            return ts, text.strip()
    return None


def _format_timestamp(ms: int) -> str:
    """Convert milliseconds to ``[mm:ss.mmm]`` string."""
    m = ms // 60000
    s = (ms % 60000) // 1000
    r = ms % 1000
    return f"[{m:02d}:{s:02d}.{r:03d}]"


# ============================================================================
# Safe File Operations -- Catch MP3 header errors and auto-repair
# ============================================================================


def _is_mp3_header_error(exc: Exception) -> bool:
    """Check if an exception indicates an MP3 header error."""
    msg = str(exc)
    return "can't sync to MPEG frame" in msg or "HeaderNotFoundError" in msg


def _safe_open_audio(audio_path: str) -> Any:
    """
    Try to open an audio file with mutagen.
    Auto-repair MP3 header errors and retry.

    Returns
    -------
    mutagen.File or None
        The opened audio file object, or None if opening fails.
    """
    repair_attempted = False
    while True:
        try:
            return MutagenFile(audio_path)
        except Exception as e:
            if (
                not repair_attempted
                and audio_path.lower().endswith(".mp3")
                and _is_mp3_header_error(e)
            ):
                logger.info("Detected MP3 header error, attempting auto-repair...")
                repair_attempted = True
                ok, _, err = repair_mp3_file(audio_path)
                if ok:
                    continue
                logger.error(f"MP3 repair failed: {err}")
            return None


# ============================================================================
# Existing Lyrics Detection & Processing
# ============================================================================

_METADATA_KEYWORDS = [
    "作词", "作詞", "作曲", "编曲", "編曲",
    "歌手", "演唱",
    "作词 :", "作詞 :", "作曲 :", "编曲 :", "編曲 :", "歌手 :", "演唱 :",
    "作词:", "作詞:", "作曲:", "编曲:", "編曲:", "歌手:", "演唱:",
    "Title", "title", "TITLE",
    "Artist", "artist", "ARTIST",
    "Album", "album", "ALBUM",
    "By", "by", "BY",
]


def extract_lyrics_from_uslt(uslt_content: str) -> List[Tuple[int, str]]:
    """
    Extract timestamped lyrics from USLT text content.

    Parameters
    ----------
    uslt_content : str
        The raw USLT frame text.

    Returns
    -------
    list of (int, str)
        List of ``(timestamp_ms, text)`` tuples sorted by timestamp.
    """
    if not uslt_content:
        return []
    lyrics = []
    for line in uslt_content.split("\n"):
        parsed = _parse_timestamp_line(line)
        if parsed is None:
            continue
        ts, text = parsed
        is_meta = any(kw in text for kw in _METADATA_KEYWORDS)
        if text and not is_meta and len(text) > 1:
            lyrics.append((ts, text))
    lyrics.sort(key=lambda x: x[0])
    logger.info(f"Extracted {len(lyrics)} lyric lines from USLT")
    return lyrics


def _build_segments_from_trilingual(
    lyrics_data: List[Tuple[int, str]], source_name: str
) -> Dict[str, Any]:
    """Build segments from trilingual lyrics (JP/romaji/ZH)."""
    segments = []
    for ts, text in lyrics_data:
        parts = text.split("\n", 2)
        orig = parts[0] if len(parts) >= 1 else ""
        trans = (
            parts[2] if len(parts) >= 3 else (parts[1] if len(parts) >= 2 else parts[0])
        )
        segments.append(
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": orig.strip(),
                "translated_text": trans.strip(),
            }
        )
    return {
        "segments": segments,
        "language": "ja",
        "is_bilingual": True,
        "is_trilingual": True,
        "source": source_name,
    }


def _build_segments_from_bilingual(
    lyrics_data: List[Tuple[int, str]], source_name: str
) -> Dict[str, Any]:
    """Build segments from bilingual lyrics."""
    segments = []
    for ts, text in lyrics_data:
        if "\n" in text:
            parts = text.split("\n", 1)
            orig, trans = parts[0], parts[1]
        else:
            orig = trans = text
        segments.append(
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": orig.strip(),
                "translated_text": trans.strip(),
            }
        )
    return {
        "segments": segments,
        "language": "unknown",
        "is_bilingual": True,
        "source": source_name,
    }


def check_and_process_existing_lyrics(
    audio_path: str,
    local_model_dir: Optional[str] = None,
    translation_mode: str = "line_by_line",
    llm_api_config: Optional[Dict[str, Any]] = None,
    detected_lang: Optional[str] = None,
    whisper_model_size: str = "medium",
) -> Optional[Dict[str, Any]]:
    """
    Check embedded lyrics (SYLT / USLT / FLAC Vorbis) in an audio file.

    Determines the next action:
    - Already bilingual/trilingual → return directly
    - Monolingual → trigger translation
    - No lyrics → return None (caller should do Whisper transcription)

    Parameters
    ----------
    audio_path : str
        Path to the audio file.
    local_model_dir : str or None
        Local directory for translation model.
    translation_mode : str
        ``"line_by_line"``, ``"llm"``, or ``"context"``.
    llm_api_config : dict or None
        Configuration for LLM API translation.
    detected_lang : str or None
        Pre-detected language code.
    whisper_model_size : str
        Whisper model size for fallback detection.

    Returns
    -------
    dict or None
        Segments result dict, or None if no lyrics found.
    """
    audio = _safe_open_audio(audio_path)
    if audio is None:
        return None

    tags = audio.tags

    # ---- MP3 (ID3) ----
    if tags and isinstance(tags, ID3):
        # Synchronized lyrics SYLT
        sylt_frames = tags.getall("SYLT")
        if sylt_frames:
            logger.info("Found SYLT synchronized lyrics")
            sylt_data = sylt_frames[0].text
            lyrics_data = [(ts, txt) for txt, ts in sylt_data]
            has_nl = any("\n" in txt for _, txt in lyrics_data[:5])
            if has_nl:
                sample = [txt for _, txt in lyrics_data[:5] if "\n" in txt]
                is_tri = sample and sample[0].count("\n") >= 2
                if is_tri:
                    logger.info("Found trilingual SYLT (JP/romaji/ZH)")
                    return _build_segments_from_trilingual(lyrics_data, "sylt_trilingual")
                else:
                    logger.info("Found bilingual SYLT")
                    return _build_segments_from_bilingual(lyrics_data, "sylt_bilingual")
            else:
                logger.info("Monolingual SYLT, needs translation")
                return process_lyrics_with_translation(
                    lyrics_data, audio_path, local_model_dir,
                    translation_mode, llm_api_config, detected_lang, whisper_model_size,
                )

        # Unsynchronized lyrics USLT
        uslt_frames = tags.getall("USLT")
        if uslt_frames:
            logger.info("Found USLT lyric frames")
            content = uslt_frames[0].text if hasattr(uslt_frames[0], "text") else None
            if content:
                lyrics_data = extract_lyrics_from_uslt(content)
                if lyrics_data:
                    has_nl = any("\n" in txt for _, txt in lyrics_data[:5])
                    if has_nl:
                        sample = [txt for _, txt in lyrics_data[:5] if "\n" in txt]
                        is_tri = sample and sample[0].count("\n") >= 2
                        if is_tri:
                            return _build_segments_from_trilingual(lyrics_data, "uslt_trilingual")
                        else:
                            return _build_segments_from_bilingual(lyrics_data, "uslt_bilingual")
                    else:
                        return process_lyrics_with_translation(
                            lyrics_data, audio_path, local_model_dir,
                            translation_mode, llm_api_config, detected_lang, whisper_model_size,
                        )

    # ---- FLAC (Vorbis) ----
    if isinstance(audio, FLAC) and tags:
        synced_fields = ["SYNCED LYRICS", "SYNCED_LYRICS", "slyrics", "SLYRICS"]
        for field in synced_fields:
            if field in tags:
                lyrics_data = []
                for line in tags[field]:
                    parsed = _parse_timestamp_line(line)
                    if parsed:
                        lyrics_data.append(parsed)
                if lyrics_data:
                    lyrics_data.sort(key=lambda x: x[0])
                    logger.info("Found FLAC synchronized lyrics")
                    return process_lyrics_with_translation(
                        lyrics_data, audio_path, local_model_dir,
                        translation_mode, llm_api_config, detected_lang, whisper_model_size,
                    )

    # ---- External lyric files ----
    external = _check_external_lyric_files(
        audio_path, local_model_dir, translation_mode,
        llm_api_config, detected_lang, whisper_model_size,
    )
    if external:
        return external

    return None


# ============================================================================
# External Lyric File Handling
# ============================================================================


def _check_external_lyric_files(
    audio_path: str,
    local_model_dir: Optional[str],
    translation_mode: str,
    llm_api_config: Optional[Dict[str, Any]],
    detected_lang: Optional[str],
    whisper_model_size: str,
) -> Optional[Dict[str, Any]]:
    """Search for external lyric files matching the audio filename."""
    audio_dir = os.path.dirname(audio_path)
    audio_name = os.path.splitext(os.path.basename(audio_path))[0]
    extensions = [".lrc", ".txt", ".srt", ".ass", ".ssa", ".uslt", ".sylt"]
    lyric_files = []
    for ext in extensions:
        exact = os.path.join(audio_dir, audio_name + ext)
        if os.path.exists(exact):
            lyric_files.append(exact)
        for f in os.listdir(audio_dir):
            if f.startswith(audio_name) and f.lower().endswith(ext):
                full = os.path.join(audio_dir, f)
                if full not in lyric_files:
                    lyric_files.append(full)
    if not lyric_files:
        return None
    logger.info(f"Found {len(lyric_files)} external lyric file(s)")
    for lf in lyric_files:
        try:
            result = _process_external_lyric(
                lf, audio_path, local_model_dir, translation_mode,
                llm_api_config, detected_lang, whisper_model_size,
            )
            if result:
                return result
        except Exception as e:
            logger.warning(f"Failed to process external lyric {lf}: {e}")
    return None


def _process_external_lyric(
    lyric_path: str,
    audio_path: str,
    local_model_dir: Optional[str],
    translation_mode: str,
    llm_api_config: Optional[Dict[str, Any]],
    detected_lang: Optional[str],
    whisper_model_size: str,
) -> Optional[Dict[str, Any]]:
    """Process a single external lyric file."""
    ext = os.path.splitext(lyric_path)[1].lower()
    if ext == ".lrc":
        lyrics_data = parse_lrc_file(lyric_path)
    elif ext == ".srt":
        lyrics_data = parse_srt_file(lyric_path)
    elif ext == ".txt":
        lyrics_data = parse_txt_file(lyric_path, audio_path)
    else:
        lyrics_data = parse_lrc_file(lyric_path)

    if not lyrics_data:
        return None
    logger.info(f"Parsed external lyrics: {len(lyrics_data)} lines")

    if detected_lang is None:
        detected_lang = detect_language_from_lyrics(lyrics_data, audio_path, whisper_model_size)

    if detected_lang == "zh":
        segments = [
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": txt,
                "translated_text": txt,
            }
            for ts, txt in lyrics_data
        ]
        return {
            "segments": segments,
            "language": "zh",
            "is_bilingual": False,
            "source": f"external_{ext[1:]}",
        }

    if translation_mode == "llm" and llm_api_config:
        return translate_with_llm_api(
            lyrics_data, llm_api_config, audio_path,
            local_model_dir, detected_lang, whisper_model_size,
        )
    return process_lyrics_with_translation(
        lyrics_data, audio_path, local_model_dir,
        translation_mode, llm_api_config, detected_lang, whisper_model_size,
    )


# ============================================================================
# Lyric File Parsers
# ============================================================================


def parse_lrc_content(content: str) -> List[Tuple[int, str]]:
    """
    Parse LRC format string into ``[(timestamp_ms, text), ...]``.

    Parameters
    ----------
    content : str
        Raw LRC file content.

    Returns
    -------
    list of (int, str)
        Sorted list of timestamp-text pairs.
    """
    lyrics = []
    for line in content.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Skip metadata lines like [ar:...]
        if line.startswith("[") and ":" in line:
            bracket_part = line.split("]")[0] if "]" in line else line
            if not any(c.isdigit() for c in bracket_part):
                continue
        parsed = _parse_timestamp_line(line)
        if parsed:
            ts, text = parsed
            if text and not text.startswith("作詞") and len(text) > 1:
                lyrics.append((ts, text))
    lyrics.sort(key=lambda x: x[0])
    return lyrics


def parse_lrc_file(lrc_path: str) -> List[Tuple[int, str]]:
    """Parse a .lrc file, trying UTF-8 then GBK encoding."""
    try:
        with open(lrc_path, "r", encoding="utf-8") as f:
            return parse_lrc_content(f.read())
    except UnicodeDecodeError:
        try:
            with open(lrc_path, "r", encoding="gbk") as f:
                return parse_lrc_content(f.read())
        except Exception as e:
            logger.warning(f"LRC encoding parse failed: {e}")
    except Exception as e:
        logger.warning(f"LRC parse failed: {e}")
    return []


def parse_srt_file(srt_path: str) -> List[Tuple[int, str]]:
    """Parse a .srt subtitle file."""
    lyrics = []
    try:
        with open(srt_path, "r", encoding="utf-8") as f:
            blocks = f.read().strip().split("\n\n")
        for block in blocks:
            lines = block.split("\n")
            if len(lines) < 3 or "-->" not in lines[1]:
                continue
            time_parts = lines[1].split("-->")
            if len(time_parts) != 2:
                continue
            start_str = time_parts[0].strip()
            text = " ".join(lines[2:]).strip()
            if not text:
                continue
            if "," in start_str:
                main, frac = start_str.split(",", 1)
                ms = int(frac) if frac else 0
            else:
                main, ms = start_str, 0
            parts = main.split(":")
            if len(parts) == 3:
                h, m, s = map(int, parts)
                ts = (h * 3600 + m * 60 + s) * 1000 + ms
                lyrics.append((ts, text))
    except Exception as e:
        logger.warning(f"SRT parse failed: {e}")
    lyrics.sort(key=lambda x: x[0])
    return lyrics


def parse_txt_file(txt_path: str, audio_path: str) -> List[Tuple[int, str]]:
    """
    Parse a .txt lyric file (no timestamps).
    Timestamps are evenly distributed across audio duration.

    Parameters
    ----------
    txt_path : str
        Path to the .txt file.
    audio_path : str
        Path to the audio file (for duration estimation).

    Returns
    -------
    list of (int, str)
    """
    lyrics = []
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        try:
            audio = MutagenFile(audio_path)
            duration = (
                audio.info.length if audio and hasattr(audio.info, "length") else 180
            )
        except Exception:
            duration = 180
        if lines:
            interval = (duration * 1000) / len(lines)
            for i, line in enumerate(lines):
                lyrics.append((int(i * interval), line))
    except Exception as e:
        logger.warning(f"TXT parse failed: {e}")
    return lyrics


# ============================================================================
# Language Detection
# ============================================================================


def detect_language_from_lyrics(
    lyrics_data: List[Tuple[int, str]],
    audio_path: str,
    whisper_model_size: str = "medium",
) -> str:
    """
    Detect language from lyric text content (regex heuristics).
    Falls back to Whisper-based detection if heuristics are inconclusive.

    Returns language code: "ja", "zh", "ko", "en", or "nn" (no language).
    """
    all_text = " ".join(txt for _, txt in lyrics_data)
    if not all_text.strip():
        return detect_language(audio_path, whisper_model_size)
    if re.search(r"[\u4e00-\u9fff]", all_text):
        return "zh"
    if re.search(r"[\u3040-\u309f\u30a0-\u30ff]", all_text):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", all_text):
        return "ko"
    return detect_language(audio_path, whisper_model_size)


def detect_language(
    audio_path: str,
    whisper_model_size: str = "medium",
    device: Optional[str] = None,
    vad_model_path: Optional[str] = None,
    vocal_audio_path: Optional[str] = None,
    manual_language: Optional[str] = None,
) -> str:
    """
    Use Whisper to detect audio language.

    Parameters
    ----------
    audio_path : str
        Path to audio file.
    whisper_model_size : str
        Whisper model size.
    device : str or None
        Compute device.
    vad_model_path : str or None
        Path to VAD model for vocal extraction.
    vocal_audio_path : str or None
        Pre-extracted vocal path (from Demucs) for more accurate detection.
    manual_language : str or None
        If set, skip detection and return this language code.

    Returns
    -------
    str
        Language code (e.g., "ja", "zh", "ko", "en") or "nn" for instrumental.
    """
    if manual_language:
        logger.info(f"Using manually specified language: {manual_language}")
        return manual_language

    if device is None:
        device = get_device()
    logger.info(f"Detecting language, model: {whisper_model_size}")

    # Prefer Demucs-extracted vocals, then VAD extraction
    audio_for_detect = audio_path
    temp_dir = None
    if vocal_audio_path and os.path.exists(vocal_audio_path):
        audio_for_detect = vocal_audio_path
        logger.info("Using Demucs-separated vocals for language detection")
    elif vad_model_path is not None:
        temp_dir = tempfile.mkdtemp()
        vocal_path = os.path.join(temp_dir, "vocal_for_detection.wav")
        try:
            extract_vocal_with_vad(audio_path, vocal_path, vad_model_path)
            if os.path.exists(vocal_path):
                audio_for_detect = vocal_path
                logger.info("Using VAD-extracted vocals for language detection")
        except Exception as e:
            logger.warning(f"VAD extraction failed: {e}")

    try:
        model = whisper.load_model(whisper_model_size, device=device)
        audio = whisper.load_audio(audio_for_detect)
        audio = whisper.pad_or_trim(audio)
        mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
        _, probs = model.detect_language(mel)
        lang = max(probs, key=probs.get)
        logger.info(f"Detected language: {lang} (confidence: {probs[lang]:.2f})")
        del model
        cleanup_gpu()
        if lang == "nn" or probs[lang] < 0.5:
            logger.info("Likely instrumental (no vocals)")
            return "nn"
        return lang
    finally:
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)


def detect_language_multi_gpu(
    audio_path: str,
    whisper_model_size: str,
    device: Optional[str],
    vad_model_path: Optional[str],
) -> str:
    """Multi-GPU optimized language detection using the global GPU manager."""
    if device is None:
        device = _get_gpu_manager().device
    logger.info(f"Detecting language, device: {device}")
    model = load_whisper_model(whisper_model_size, device)
    audio = whisper.load_audio(audio_path)
    audio = whisper.pad_or_trim(audio)
    mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(device)
    _, probs = model.detect_language(mel)
    lang = max(probs, key=probs.get)
    del model
    cleanup_gpu()
    logger.info(f"Detected language: {lang} (confidence: {probs[lang]:.2f})")
    return lang


# ============================================================================
# Model Loading
# ============================================================================


def load_whisper_model(model_size: str, device: Optional[str] = None) -> Any:
    """Load a Whisper model with multi-GPU support."""
    if device is None:
        device = _get_gpu_manager().device
    logger.info(f"Loading Whisper {model_size} → {device}")
    model = whisper.load_model(model_size, device=device)
    if _get_gpu_manager().available_gpus and MULTI_GPU_CONFIG["enabled"]:
        model = _get_gpu_manager().setup_model(model, "whisper")
    return model


def load_translation_model(
    model_name: str,
    local_model_dir: Optional[str] = None,
    device: Optional[str] = None,
) -> Tuple[Any, Any]:
    """Load a translation model (AutoModelForSeq2SeqLM + tokenizer)."""
    if device is None:
        device = _get_gpu_manager().device
    logger.info(f"Loading translation model → {device}")
    if local_model_dir and os.path.isdir(local_model_dir):
        logger.info(f"Using local model: {local_model_dir}")
        tokenizer = AutoTokenizer.from_pretrained(local_model_dir)
        model = AutoModelForSeq2SeqLM.from_pretrained(local_model_dir)
    else:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
        tokenizer = AutoTokenizer.from_pretrained(model_name)
        model = AutoModelForSeq2SeqLM.from_pretrained(model_name)
    if _get_gpu_manager().available_gpus and MULTI_GPU_CONFIG["enabled"]:
        model = _get_gpu_manager().setup_model(model, "translation")
    else:
        model = model.to(device)
    return tokenizer, model


def get_model_config(local_model_dir: Optional[str] = None) -> Dict[str, Any]:
    """Infer translation model config (NLLB / M2M100) from path or name."""
    if local_model_dir and os.path.isdir(local_model_dir):
        path_lower = local_model_dir.lower()
        if "nllb" in path_lower or "3.3b" in path_lower:
            return MODEL_CONFIGS["NLLB-200-3.3B"]
        if "m2m100" in path_lower or "418m" in path_lower:
            return MODEL_CONFIGS["M2M100_418M"]
        config_path = os.path.join(local_model_dir, "config.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                if "nllb" in cfg.get("_name_or_path", "").lower():
                    return MODEL_CONFIGS["NLLB-200-3.3B"]
            except Exception:
                pass
        return MODEL_CONFIGS["M2M100_418M"]
    name = local_model_dir or ""
    if "nllb" in name.lower():
        return MODEL_CONFIGS["NLLB-200-3.3B"]
    return MODEL_CONFIGS["M2M100_418M"]


# ============================================================================
# Translation Model Loader (shared helper)
# ============================================================================


def _load_translation_model_for_processing(
    local_model_dir: Optional[str], device: str
) -> Tuple[Any, Any, Dict[str, Any]]:
    """Unified translation model loading entry (reused across translation functions)."""
    model_config = get_model_config(local_model_dir)
    logger.info(f"Using model: {model_config.get('model_name', local_model_dir)}")
    if local_model_dir and os.path.isdir(local_model_dir):
        tokenizer = AutoTokenizer.from_pretrained(local_model_dir)
        model = AutoModelForSeq2SeqLM.from_pretrained(
            local_model_dir,
            torch_dtype=torch.float16 if device == "cuda" else torch.float32,
        ).to(device)
    else:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
        model_name = model_config.get("model_name", "facebook/m2m100_418M")
        tokenizer = AutoTokenizer.from_pretrained(model_name, cache_dir="./model_cache")
        model = AutoModelForSeq2SeqLM.from_pretrained(
            model_name,
            cache_dir="./model_cache",
            torch_dtype=torch.float16 if device == "cuda" else torch.float32,
        ).to(device)
    return tokenizer, model, model_config


def _configure_tokenizer_lang(
    tokenizer: Any, model_config: Dict[str, Any], detected_lang: str
) -> Tuple[str, str]:
    """Configure the tokenizer's source language. Returns (src_lang, tgt_lang)."""
    src_lang = model_config["lang_mapping"].get(detected_lang, detected_lang)
    tokenizer.src_lang = src_lang
    return src_lang, model_config["tgt_lang"]


def _get_forced_bos_id(tokenizer: Any, tgt_lang: str, is_nllb: bool) -> int:
    """Get forced_bos_token_id for translation generation."""
    if is_nllb:
        return tokenizer.convert_tokens_to_ids(tgt_lang)
    return tokenizer.lang_code_to_id[tgt_lang]


def _generate_translation(
    model: nn.Module,
    encoded: Dict[str, torch.Tensor],
    forced_bos_id: int,
    max_length: int = 512,
    **kwargs,
) -> torch.Tensor:
    """Run model inference for translation. Extra kwargs passed to generate()."""
    gen_kwargs = dict(
        forced_bos_token_id=forced_bos_id,
        max_length=max_length,
        num_beams=5,
        early_stopping=True,
        **kwargs,
    )
    if isinstance(model, nn.DataParallel):
        return model.module.generate(**encoded, **gen_kwargs)
    return model.generate(**encoded, **gen_kwargs)


def _convert_traditional_to_simplified(segments: List[Dict[str, Any]]) -> None:
    """Convert Traditional Chinese to Simplified Chinese in translated_text (requires zhconv)."""
    try:
        from zhconv import convert

        for seg in segments:
            seg["translated_text"] = convert(seg["translated_text"], "zh-cn")
        logger.info("Converted Traditional Chinese to Simplified Chinese")
    except ImportError:
        logger.warning("zhconv not installed, skipping traditional→simplified conversion")
    except Exception as e:
        logger.warning(f"Traditional→simplified conversion error: {e}")


# ============================================================================
# Local Model Line-by-Line Translation
# ============================================================================


def process_lyrics_with_translation(
    lyrics_data: List[Tuple[int, str]],
    audio_path: str,
    local_model_dir: Optional[str] = None,
    translation_mode: str = "line_by_line",
    llm_api_config: Optional[Dict[str, Any]] = None,
    detected_lang: Optional[str] = None,
    whisper_model_size: str = "medium",
) -> Dict[str, Any]:
    """
    Translate lyrics line by line.

    If the detected language is Chinese, returns segments as-is.
    Otherwise loads a local translation model and translates each line.

    Parameters
    ----------
    lyrics_data : list of (int, str)
        List of (timestamp_ms, text) tuples.
    audio_path : str
        Path to audio file (for language detection).
    local_model_dir : str or None
        Local directory for translation model.
    translation_mode : str
        ``"line_by_line"``, ``"llm"``, or ``"context"``.
    llm_api_config : dict or None
        LLM API config.
    detected_lang : str or None
        Language code.
    whisper_model_size : str
        Whisper model size for fallback detection.

    Returns
    -------
    dict
        Result with "segments", "language", "is_bilingual", "source".
    """
    if detected_lang is None:
        detected_lang = detect_language(audio_path, "medium")
    logger.info(f"Lyric language: {detected_lang}")

    if detected_lang == "zh":
        segments = [
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": txt,
                "translated_text": txt,
            }
            for ts, txt in lyrics_data
        ]
        return {
            "segments": segments,
            "language": detected_lang,
            "is_bilingual": False,
            "source": "existing_chinese",
        }

    if translation_mode == "llm" and llm_api_config:
        return translate_with_llm_api(
            lyrics_data, llm_api_config, audio_path,
            local_model_dir, detected_lang, whisper_model_size,
        )

    logger.info("Translating with local model line-by-line...")
    device = get_device()
    tokenizer, model, model_config = _load_translation_model_for_processing(
        local_model_dir, device
    )
    src_lang, tgt_lang = _configure_tokenizer_lang(tokenizer, model_config, detected_lang)
    forced_bos_id = _get_forced_bos_id(tokenizer, tgt_lang, model_config["is_nllb"])

    segments = []
    for ts, orig_text in tqdm(lyrics_data, desc="Lyric translation"):
        try:
            encoded = tokenizer(orig_text, return_tensors="pt", padding=True).to(device)
            generated = _generate_translation(model, encoded, forced_bos_id)
            translated = tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
            segments.append(
                {
                    "start": ts / 1000.0,
                    "end": ts / 1000.0 + 3.0,
                    "original_text": orig_text,
                    "translated_text": translated,
                }
            )
        except Exception as e:
            logger.warning(f"Translation failed [{orig_text}]: {e}")
            segments.append(
                {
                    "start": ts / 1000.0,
                    "end": ts / 1000.0 + 3.0,
                    "original_text": orig_text,
                    "translated_text": orig_text,
                }
            )

    _convert_traditional_to_simplified(segments)
    del model
    cleanup_gpu()
    return {
        "segments": segments,
        "language": detected_lang,
        "is_bilingual": True,
        "source": "translated",
    }


# ============================================================================
# LLM API Whole-Song Translation (OpenAI Compatible)
# ============================================================================


def translate_with_llm_api(
    lyrics_data: List[Tuple[int, str]],
    api_config: Dict[str, Any],
    audio_path: str,
    local_model_dir: Optional[str] = None,
    detected_lang: Optional[str] = None,
    whisper_model_size: str = "medium",
) -> Dict[str, Any]:
    """
    Send timestamped lyrics to an LLM API (OpenAI-compatible) for whole-song translation.

    Parameters
    ----------
    lyrics_data : list of (int, str)
        Timestamped lyrics.
    api_config : dict
        Must contain "endpoint", "model", "api_key".
    audio_path : str
        Path to audio file (for fallback).
    local_model_dir : str or None
        Local model directory for fallback.
    detected_lang : str or None
        Language code.
    whisper_model_size : str
        Whisper model size for fallback detection.

    Returns
    -------
    dict
        Segments result.
    """
    endpoint = api_config.get("endpoint", "http://127.0.0.1:11435/v1/chat/completions")
    model_name = api_config.get("model")
    if not model_name:
        raise ValueError("api_config missing 'model'")
    provider = api_config.get("provider", "openai")
    timeout = api_config.get("timeout", 120)
    temperature = api_config.get("temperature", 0.7)
    response_format = api_config.get("response_format")
    max_tokens = api_config.get("max_tokens")

    lyrics_text = "".join(f"{_format_timestamp(ts)}{txt}\n" for ts, txt in lyrics_data)

    prompt = api_config.get(
        "prompt",
        "Strictly translate each line of the following lyrics into Simplified Chinese. "
        "Rules: input `[timestamp]original`, output `[same timestamp]Chinese`. "
        "One line per line, same number of lines, no merging or extra text. "
        "Output translations only.\n",
    )

    messages = [{"role": "user", "content": f"{prompt}\n{lyrics_text}"}]
    if api_config.get("prompt_system"):
        messages.insert(0, {"role": "system", "content": api_config["prompt_system"]})

    payload = {"model": model_name, "messages": messages, "temperature": temperature}
    if max_tokens:
        payload["max_tokens"] = max_tokens
    if response_format:
        payload["response_format"] = response_format

    try:
        logger.info(f"Calling {provider} API to translate full song ({len(lyrics_data)} lines)")
        resp = requests.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {api_config['api_key']}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
        if resp.status_code != 200:
            raise Exception(f"API request failed: {resp.status_code}")
        result = resp.json()
        translated_text = result["choices"][0]["message"]["content"]
        return parse_llm_translation(lyrics_data, translated_text, api_config)
    except Exception as e:
        logger.error(f"{provider} API translation failed: {e}")
        return translate_line_by_line_fallback(
            lyrics_data, audio_path, local_model_dir, detected_lang, whisper_model_size,
        )


def translate_line_by_line_fallback(
    lyrics_data: List[Tuple[int, str]],
    audio_path: str,
    local_model_dir: Optional[str] = None,
    detected_lang: Optional[str] = None,
    whisper_model_size: str = "medium",
) -> Dict[str, Any]:
    """Fallback to local model line-by-line translation when API fails."""
    logger.warning("API translation failed, falling back to line-by-line")
    if detected_lang is None:
        detected_lang = detect_language(audio_path, whisper_model_size)
    if detected_lang == "zh":
        segments = [
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": txt,
                "translated_text": txt,
            }
            for ts, txt in lyrics_data
        ]
        return {
            "segments": segments,
            "language": detected_lang,
            "is_bilingual": False,
            "source": "existing_chinese",
        }
    return process_lyrics_with_translation(
        lyrics_data, audio_path, local_model_dir,
        "line_by_line", None, detected_lang, whisper_model_size,
    )


def parse_llm_translation(
    lyrics_data: List[Tuple[int, str]],
    translated_text: str,
    api_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Parse LLM API translation response: try JSON first, then line-by-line alignment."""
    json_segments = _parse_llm_json(lyrics_data, translated_text)
    if json_segments is not None:
        return json_segments

    lines = [ln.strip() for ln in translated_text.splitlines() if ln.strip()]
    if lines and len(lines) == len(lyrics_data):
        segments = []
        for (ts, orig), line in zip(lyrics_data, lines):
            trans = line.split("]", 1)[1].strip() if "]" in line else line
            segments.append(
                {
                    "start": ts / 1000.0,
                    "end": ts / 1000.0 + 3.0,
                    "original_text": orig,
                    "translated_text": trans,
                }
            )
        return {
            "segments": segments,
            "language": "unknown",
            "is_bilingual": True,
            "source": "llm_api",
        }

    logger.warning(
        f"API returned {len(lines)} lines vs original {len(lyrics_data)} lines, smart-matching"
    )
    return smart_match_translation(lyrics_data, lines)


def _parse_llm_json(
    lyrics_data: List[Tuple[int, str]], translated_text: str
) -> Optional[Dict[str, Any]]:
    """Try parsing LLM API response as JSON and match by original text."""
    text = translated_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        data = json.loads(text)
    except Exception:
        return None

    items = None
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in ("translation", "segments", "lines", "data"):
            if key in data and isinstance(data[key], list):
                items = data[key]
                break
    if not items:
        return None

    pairs = []
    for it in items:
        if not isinstance(it, dict):
            continue
        orig = it.get("original") or it.get("source") or it.get("原词")
        trans = it.get("translated") or it.get("translation") or it.get("译文")
        if orig and trans:
            pairs.append((str(orig).strip(), str(trans).strip()))

    if not pairs:
        return None

    text_to_ts = {str(txt).strip(): ts for ts, txt in lyrics_data}
    segments = []
    for orig, trans in pairs:
        ts = text_to_ts.get(orig)
        if ts is None:
            norm = re.sub(r"\s+", "", orig)
            for raw_txt, cand_ts in text_to_ts.items():
                if re.sub(r"\s+", "", raw_txt) == norm:
                    ts = cand_ts
                    break
        if ts is None:
            logger.warning(f"JSON translation unmatched: {orig!r}")
            continue
        segments.append(
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": orig,
                "translated_text": trans,
            }
        )
    return {
        "segments": segments,
        "language": "unknown",
        "is_bilingual": True,
        "source": "llm_api_json",
    }


def smart_match_translation(
    lyrics_data: List[Tuple[int, str]], translated_lines: List[str]
) -> Dict[str, Any]:
    """Smart-align translation lines to original lyrics by timestamp + sequence."""
    by_time: Dict[int, str] = {}
    untimed: List[str] = []
    for line in translated_lines:
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$", line)
        if m:
            ts = int(m.group(1)) * 60000 + int(m.group(2)) * 1000
            frac = (m.group(3) or "0")[:3].ljust(3, "0")
            ts += int(frac)
            by_time[ts] = m.group(4).strip()
        else:
            untimed.append(line)

    segments = []
    for ts, orig in lyrics_data:
        trans = by_time.get(ts)
        if trans is None:
            for t, txt in by_time.items():
                if abs(t - ts) <= 1500:
                    trans = txt
                    break
        if trans is None and untimed:
            trans = untimed.pop(0)
        if trans is None:
            trans = orig
        segments.append(
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": orig,
                "translated_text": trans,
            }
        )
    return {
        "segments": segments,
        "language": "unknown",
        "is_bilingual": True,
        "source": "llm_api",
    }


# ============================================================================
# Multi-GPU Local Translation
# ============================================================================


def translate_with_local_model_multi_gpu(
    transcription: Dict[str, Any],
    detected_lang: str,
    local_model_dir: Optional[str],
    device: Optional[str],
) -> Dict[str, Any]:
    """Multi-GPU optimized local model translation for Whisper transcriptions."""
    if device is None:
        device = _get_gpu_manager().device
    model_config = get_model_config(local_model_dir)
    tokenizer, model = load_translation_model(
        model_config.get("model_name", ""), local_model_dir, device
    )
    src_lang, tgt_lang = _configure_tokenizer_lang(tokenizer, model_config, detected_lang)
    forced_bos_id = _get_forced_bos_id(tokenizer, tgt_lang, model_config["is_nllb"])

    seg_texts = [
        s["text"].strip()
        for s in transcription["segments"]
        if s.get("text", "").strip()
    ]
    chunks = _pack_chunks(seg_texts, model_config["chunk_size"])

    translated_chunks = []
    for chunk in tqdm(chunks, desc="Translation progress"):
        encoded = tokenizer(chunk, return_tensors="pt", padding=True).to(device)
        generated = _generate_translation(model, encoded, forced_bos_id)
        translated_chunks.append(
            tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
        )

    translated_text = " ".join(translated_chunks)

    segments = []
    for seg in tqdm(transcription["segments"], desc="Segment translation"):
        encoded = tokenizer(seg["text"], return_tensors="pt", padding=True).to(device)
        generated = _generate_translation(model, encoded, forced_bos_id)
        trans = tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
        segments.append(
            {
                "start": seg["start"],
                "end": seg["end"],
                "original_text": seg["text"],
                "translated_text": trans,
            }
        )

    del model
    cleanup_gpu()

    try:
        from zhconv import convert

        for seg in segments:
            seg["translated_text"] = convert(seg["translated_text"], "zh-cn")
    except ImportError:
        pass

    return {
        "original_text": transcription["text"],
        "translated_text": translated_text,
        "segments": segments,
        "language": detected_lang,
        "duration": 0,
    }


def _pack_chunks(texts: List[str], max_chars: int) -> List[str]:
    """Pack text list into chunks respecting max character limit."""
    chunks = []
    cur = ""
    for t in texts:
        if len(cur) + len(t) + 1 > max_chars and cur:
            chunks.append(cur)
            cur = t
        else:
            cur = f"{cur} {t}".strip() if cur else t
    if cur:
        chunks.append(cur)
    return chunks


# ============================================================================
# Demucs Vocal Separation
# ============================================================================


def separate_vocals_with_demucs(
    audio_path: str,
    output_dir: Optional[str] = None,
    demucs_config: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """
    Use Demucs to separate vocals from music.

    Parameters
    ----------
    audio_path : str
        Path to audio file.
    output_dir : str or None
        Output directory. Uses temp dir if None.
    demucs_config : dict or None
        Demucs configuration dict.

    Returns
    -------
    str or None
        Path to the separated vocals file, or None on failure.
    """
    if not DEMUCS_AVAILABLE:
        logger.warning("Demucs not available, skipping vocal separation")
        return None
    cfg = demucs_config or DEMUCS_CONFIG
    if not cfg.get("enabled", True):
        return None

    try:
        logger.info("=" * 50)
        logger.info(f"Demucs vocal separation: model={cfg['model']}")
        device = cfg.get("device", "auto")
        if device == "auto":
            device = get_device()

        hf_endpoint = cfg.get("hf_endpoint", "https://hf-mirror.com")
        if hf_endpoint:
            os.environ.setdefault("HF_ENDPOINT", hf_endpoint)

        repo_path = Path(cfg["local_repo"]) if cfg.get("local_repo") else None

        use_temp = output_dir is None
        if use_temp:
            output_dir = tempfile.mkdtemp(prefix="demucs_vocals_")
        os.makedirs(output_dir, exist_ok=True)

        separator = demucs_api.Separator(
            model=cfg["model"],
            repo=repo_path,
            device=device,
            segment=cfg.get("segment"),
            shifts=cfg.get("shifts", 1),
        )
        logger.info("Separating vocals...")

        result_holder: List[Any] = [None]
        error_holder: List[Any] = [None]

        def _run_separation() -> None:
            try:
                result_holder[0] = separator.separate_audio_file(Path(audio_path))
            except Exception as ex:
                error_holder[0] = ex

        thread = threading.Thread(target=_run_separation, daemon=True)
        thread.start()

        with tqdm(desc="Demucs vocal separation", bar_format="{desc}: {elapsed}") as pbar:
            while thread.is_alive():
                pbar.update(0)
                thread.join(0.1)

        if error_holder[0] is not None:
            raise error_holder[0]
        _mix, stems = result_holder[0]

        vocal_filename = (
            os.path.splitext(os.path.basename(audio_path))[0] + "_vocals.wav"
        )
        vocal_path = os.path.join(output_dir, vocal_filename)
        demucs_api.save_audio(
            stems["vocals"],
            vocal_path,
            samplerate=separator.samplerate,
            bits_per_sample=24,
        )
        logger.info(f"Vocal separation complete → {vocal_path}")
        return vocal_path
    except Exception as e:
        logger.warning(f"Demucs vocal separation failed: {e}")
        return None


# ============================================================================
# VAD (Voice Activity Detection)
# ============================================================================

_vad_pipeline_cache: Any = None


def _get_vad_pipeline() -> Any:
    """Load pyannote VAD pipeline (local first, with caching)."""
    global _vad_pipeline_cache
    if _vad_pipeline_cache is not None:
        return _vad_pipeline_cache

    logger.info("Loading pyannote VAD model...")
    os.environ.setdefault("HF_ENDPOINT", VAD_MODEL_CONFIG["hf_mirror"])
    model_dir = VAD_MODEL_CONFIG["local_path"]

    if model_dir:
        local_bin = os.path.join(model_dir, "pytorch_model.bin")
        if os.path.isfile(local_bin):
            try:
                from pyannote.audio import Model

                vad_model = Model.from_pretrained(local_bin, strict=False)
                _vad_pipeline_cache = VoiceActivityDetection(segmentation=vad_model)
                _vad_pipeline_cache.instantiate(
                    {
                        "onset": 0.5,
                        "offset": 0.5,
                        "min_duration_on": 0.0,
                        "min_duration_off": 0.0,
                    }
                )
                logger.info("pyannote VAD local model loaded successfully")
                return _vad_pipeline_cache
            except Exception as e:
                logger.warning(f"Local VAD load failed: {e}")

    try:
        from pyannote.audio import Pipeline

        _vad_pipeline_cache = Pipeline.from_pretrained(
            VAD_MODEL_CONFIG["model_name"],
            use_auth_token=False,
        )
        logger.info("pyannote VAD online model loaded successfully")
    except Exception as e:
        logger.warning(f"pyannote VAD online load failed: {e}")
    return _vad_pipeline_cache


def _release_vad_pipeline() -> None:
    """Release cached VAD pipeline and free GPU memory."""
    global _vad_pipeline_cache
    if _vad_pipeline_cache is not None:
        del _vad_pipeline_cache
        _vad_pipeline_cache = None
        cleanup_gpu()


def _get_speech_segments_webrtcvad(audio_path: str) -> List[Tuple[float, float]]:
    """Detect speech segments using webrtcvad (pure local fallback)."""
    logger.info("Running webrtcvad speech detection...")
    waveform, sr = torchaudio.load(audio_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sr != 16000:
        waveform = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)(waveform)
        sr = 16000
    audio_data = (waveform.numpy().squeeze() * 32767).astype(np.int16)

    vad = webrtcvad.Vad()
    vad.set_mode(3)
    frame_ms = 30
    frame_size = int(sr * frame_ms / 1000)

    speech_frames = []
    for i in range(0, len(audio_data) - frame_size + 1, frame_size):
        if vad.is_speech(audio_data[i : i + frame_size].tobytes(), sr):
            speech_frames.append(i / sr)

    if not speech_frames:
        return []

    segments = []
    seg_start = speech_frames[0]
    prev = speech_frames[0]
    for ft in speech_frames[1:]:
        if ft - prev > frame_ms / 1000 * 2:
            segments.append((seg_start, prev + frame_ms / 1000))
            seg_start = ft
        prev = ft
    segments.append((seg_start, prev + frame_ms / 1000))

    # Merge short gaps
    merged = []
    if segments:
        ms_, me_ = segments[0]
        for ns, ne in segments[1:]:
            if ns - me <= 0.3:
                me = ne
            else:
                merged.append((ms_, me_))
                ms_, me_ = ns, ne
        merged.append((ms_, me_))

    total_speech = sum(e - s for s, e in merged)
    logger.info(f"   VAD detected {len(merged)} speech segments, total {total_speech:.1f}s")
    return merged


def _get_speech_segments_from_vad(
    audio_path: str, vad_pipeline: Any
) -> List[Tuple[float, float]]:
    """Run pyannote VAD on clean vocals, return speech segment timeline."""
    logger.info("Running pyannote VAD speech detection...")
    vad_result = vad_pipeline(audio_path)
    segments = [(r.start, r.end) for r in vad_result.get_timeline().support()]
    total_speech = sum(e - s for s, e in segments)
    logger.info(f"   VAD detected {len(segments)} speech segments, total {total_speech:.1f}s")
    return segments


def _merge_speech_segments(
    speech_segments: List[Tuple[float, float]], merge_gap: float = 2.0
) -> List[Tuple[float, float]]:
    """Merge overlapping or close-proximity VAD segments into contiguous blocks."""
    if not speech_segments:
        return []
    sorted_segs = sorted(speech_segments, key=lambda s: s[0])
    merged_blocks = []
    block_start, block_end = sorted_segs[0]
    for seg_start, seg_end in sorted_segs[1:]:
        if seg_start - block_end <= merge_gap:
            block_end = max(block_end, seg_end)
        else:
            merged_blocks.append((block_start, block_end))
            block_start, block_end = seg_start, seg_end
    merged_blocks.append((block_start, block_end))
    logger.info(
        f"   Merged: {len(speech_segments)} → {len(merged_blocks)} contiguous speech blocks"
    )
    return merged_blocks


def _transcribe_single_block_with_fallback(
    whisper_model: Any,
    block_path: str,
    whisper_options: Dict[str, Any],
    block_duration: float,
) -> Tuple[List[Dict[str, Any]], float]:
    """Transcribe a single speech block with hallucination fallback strategies."""
    t_start = time.time()
    result = whisper_model.transcribe(block_path, **whisper_options)
    elapsed = time.time() - t_start

    segs = result.get("segments", [])
    chars = len(result.get("text", ""))
    chars_per_sec = chars / block_duration if block_duration > 0 else 0
    total_frames = block_duration * 100
    decoding_speed = total_frames / elapsed if elapsed > 0 else 0

    logger.info(
        f"      → Transcription returned: {len(segs)} segments, {chars} chars "
        f"(took {elapsed:.1f}s, {chars_per_sec:.1f} chars/s, decode {decoding_speed:.0f} fps)"
    )

    is_hallucination = (chars_per_sec < 1.0) and (decoding_speed > 500)
    if not is_hallucination:
        return segs, elapsed

    logger.warning(f"   ⚠️ Suspected hallucination: {chars_per_sec:.1f} chars/s → retrying")

    fallback_c = dict(whisper_options)
    fallback_c["temperature"] = 0.0
    fallback_c["beam_size"] = 1
    fallback_c["best_of"] = 1
    fallback_c["compression_ratio_threshold"] = 10.0
    try:
        result_c = whisper_model.transcribe(block_path, **fallback_c)
        segs_c = result_c.get("segments", [])
        chars_c = len(result_c.get("text", ""))
    except Exception:
        segs_c, chars_c = [], 0

    fallback_d = dict(fallback_c)
    fallback_d["initial_prompt"] = "歌詞"
    try:
        result_d = whisper_model.transcribe(block_path, **fallback_d)
        segs_d = result_d.get("segments", [])
        chars_d = len(result_d.get("text", ""))
    except Exception:
        segs_d, chars_d = [], 0

    candidates = [(chars, segs), (chars_c, segs_c), (chars_d, segs_d)]
    best_chars, best_segs = max(candidates, key=lambda x: x[0])
    logger.info(f"   ℹ️ Selected best result: {best_chars} chars")
    return best_segs, elapsed


def _transcribe_vad_guided(
    whisper_model: Any,
    audio_path: str,
    whisper_options: Dict[str, Any],
    vad_pipeline: Any = None,
) -> Dict[str, Any]:
    """
    VAD-guided transcription by natural speech blocks.

    Each block is transcribed independently with timestamps anchored to the
    block's original position in the audio.

    Parameters
    ----------
    whisper_model : Any
        Loaded Whisper model.
    audio_path : str
        Path to audio file.
    whisper_options : dict
        Options passed to whisper.transcribe().
    vad_pipeline : Any or None
        Pre-loaded pyannote VAD pipeline.

    Returns
    -------
    dict
        With "text", "segments", "language".
    """
    waveform, sr = torchaudio.load(audio_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0)
    else:
        waveform = waveform.squeeze(0)

    if vad_pipeline is None:
        vad_pipeline = _get_vad_pipeline()

    if vad_pipeline is not None:
        speech_segments = _get_speech_segments_from_vad(audio_path, vad_pipeline)
    else:
        logger.warning("pyannote VAD unavailable, using webrtcvad fallback")
        speech_segments = _get_speech_segments_webrtcvad(audio_path)

    if not speech_segments:
        logger.info("VAD detected no speech, likely instrumental")
        return {
            "text": "",
            "segments": [],
            "language": whisper_options.get("language", ""),
        }

    merged_blocks = _merge_speech_segments(speech_segments)
    tmpdir = tempfile.mkdtemp(prefix="whisper_blocks_")
    all_segments = []
    total_time = 0.0

    try:
        for bi, (block_start, block_end) in enumerate(merged_blocks):
            block_duration = block_end - block_start
            start_sample = int(block_start * sr)
            end_sample = int(min(block_end * sr, len(waveform)))
            chunk = waveform[start_sample:end_sample]

            if chunk.numel() == 0 or chunk.abs().max() < 0.001:
                continue

            chunk_path = os.path.join(tmpdir, f"block_{bi:04d}.wav")
            torchaudio.save(chunk_path, chunk.unsqueeze(0), sr)

            logger.info(
                f"   🎤 Transcribing block {bi}: {block_start:.1f}s → {block_end:.1f}s "
                f"(duration {block_duration:.1f}s)"
            )
            segs, elapsed = _transcribe_single_block_with_fallback(
                whisper_model, chunk_path, whisper_options, block_duration,
            )
            total_time += elapsed

            for seg in segs:
                seg_start = seg.get("start", 0)
                seg_end = seg.get("end", 0)
                text = seg.get("text", "").strip()
                if not text or len(text) <= 1:
                    continue
                if text in (
                    "歌詞", "歌词", "lyrics", "♪",
                    "ご視聴ありがとうございました",
                ):
                    continue
                all_segments.append(
                    {
                        "start": block_start + seg_start,
                        "end": block_start + seg_end,
                        "text": text,
                    }
                )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    all_segments.sort(key=lambda s: s["start"])
    full_text = " ".join(s["text"] for s in all_segments)
    logger.info(
        f"   ✅ VAD-guided transcription complete: {len(all_segments)} segments ({total_time:.1f}s)"
    )
    return {
        "text": full_text,
        "segments": all_segments,
        "language": whisper_options.get("language", ""),
    }


def _merge_segments_for_translation(
    segments: List[Dict[str, Any]], max_gap: float = 0.8, max_chars: int = 120
) -> List[Dict[str, Any]]:
    """Merge temporally adjacent segments into complete lyric lines for better translation."""
    if not segments:
        return []
    merged = []
    cur = dict(segments[0])
    for seg in segments[1:]:
        gap = seg["start"] - cur["end"]
        combined_len = len(cur["text"]) + len(seg["text"])
        if gap <= max_gap and combined_len <= max_chars:
            cur["text"] = f"{cur['text']} {seg['text']}".strip()
            cur["end"] = seg["end"]
        else:
            merged.append(cur)
            cur = dict(seg)
    merged.append(cur)
    return merged


# ============================================================================
# Safe File Operations / Output File Checks
# ============================================================================


def safe_check_and_process_existing_lyrics(
    audio_path: str,
    local_model_dir: Optional[str] = None,
    translation_mode: str = "line_by_line",
    llm_api_config: Optional[Dict[str, Any]] = None,
    whisper_model_size: str = "medium",
) -> Optional[Dict[str, Any]]:
    """
    Safe lyric check: skip missing/empty files, auto-repair corrupt MP3 headers.

    Parameters
    ----------
    audio_path : str
        Path to audio file.
    local_model_dir : str or None
        Local translation model directory.
    translation_mode : str
        Translation mode.
    llm_api_config : dict or None
        LLM API config.
    whisper_model_size : str
        Whisper model size.

    Returns
    -------
    dict or None
        Lyrics result if found, None otherwise.
    """
    if not os.path.exists(audio_path):
        logger.warning(f"File not found: {audio_path}")
        return None
    if os.path.getsize(audio_path) == 0:
        logger.warning(f"File is empty: {audio_path}")
        return None
    audio = _safe_open_audio(audio_path)
    if audio is None:
        logger.warning(f"Cannot recognize audio file: {audio_path}")
        return None
    return check_and_process_existing_lyrics(
        audio_path, local_model_dir, translation_mode,
        llm_api_config, whisper_model_size=whisper_model_size,
    )


def safe_file_operation(
    audio_path: str, operation_func: Callable, *args: Any, **kwargs: Any
) -> Any:
    """
    Safe file operation wrapper: auto-repair corrupt MP3 and retry once.

    Parameters
    ----------
    audio_path : str
        Path to audio file.
    operation_func : callable
        The operation function to execute.
    *args, **kwargs
        Arguments for the operation function.

    Returns
    -------
    Any
        Return value of operation_func, or None on failure.
    """
    if not os.path.exists(audio_path):
        logger.warning(f"File not found: {audio_path}")
        return None
    if os.path.getsize(audio_path) == 0:
        logger.warning(f"File is empty: {audio_path}")
        return None
    try:
        return operation_func(audio_path, *args, **kwargs)
    except Exception as e:
        if audio_path.lower().endswith(".mp3") and _is_mp3_header_error(e):
            logger.info("Detected MP3 header error, attempting auto-repair...")
            ok, _, err = repair_mp3_file(audio_path)
            if ok:
                logger.info("File repaired successfully, retrying operation...")
                return operation_func(audio_path, *args, **kwargs)
            logger.error(f"MP3 repair failed: {err}")
            return None
        logger.warning(f"File operation error: {e}")
        return None


def check_output_file_complete(audio_path: str) -> bool:
    """
    Check if the output file already exists and has complete lyrics.

    Parameters
    ----------
    audio_path : str
        Path to the source audio file.

    Returns
    -------
    bool
        True if output exists and contains complete lyrics or instrumental tags.
    """
    audio_output_dir = os.path.join(os.path.dirname(audio_path), "audio_with_lyrics")
    base_name = os.path.basename(audio_path)
    name, ext = os.path.splitext(base_name)
    if ext.lower() == ".m4a":
        output_path = os.path.join(audio_output_dir, name + ".mp3")
    else:
        output_path = os.path.join(audio_output_dir, base_name)
    if not os.path.exists(output_path):
        return False

    def check_audio_file(file_path: str) -> Any:
        try:
            audio = MutagenFile(file_path)
            if audio is None:
                return False
            if audio.tags and isinstance(audio.tags, ID3):
                sylt = audio.tags.getall("SYLT")
                uslt = audio.tags.getall("USLT")
                if sylt and uslt:
                    if (
                        uslt[0].text == "纯音乐 (Instrumental)"
                        and sylt[0].text
                        and sylt[0].text[0][0] == "纯音乐 (Instrumental)"
                    ):
                        logger.info(f"File is processed instrumental: {output_path}")
                    else:
                        logger.info(f"File processed with complete lyrics: {output_path}")
                    return True
            elif isinstance(audio, FLAC) and audio.tags:
                has_synced = any(
                    f in audio.tags
                    for f in ["SYNCED LYRICS", "SYNCED_LYRICS", "slyrics", "SLYRICS"]
                )
                has_unsynced = any(f in audio.tags for f in ["LYRICS", "lyrics"])
                if has_synced and has_unsynced:
                    unsynced = audio.tags.get("LYRICS", audio.tags.get("lyrics", [""]))
                    unsynced_text = unsynced[0] if unsynced else ""
                    synced_text = ""
                    for sf in ["SYNCED_LYRICS", "SYNCED LYRICS", "slyrics", "SLYRICS"]:
                        if sf in audio.tags:
                            synced_text = audio.tags.get(sf, [""])
                            if isinstance(synced_text, list):
                                synced_text = "\n".join(synced_text)
                            break
                    if (
                        unsynced_text == "纯音乐 (Instrumental)"
                        and "纯音乐 (Instrumental)" in synced_text
                    ):
                        logger.info(f"File is processed instrumental: {output_path}")
                    else:
                        logger.info(f"File processed with complete lyrics: {output_path}")
                    return True
            logger.info(f"File exists but without complete lyrics: {output_path}")
            return False
        except Exception as e:
            logger.warning(f"Error checking output file: {e}")
            return False

    return safe_file_operation(output_path, check_audio_file) or False


# ============================================================================
# Main Processing Entry
# ============================================================================


def process_audio_file(
    audio_path: str,
    whisper_model_size: str = "medium",
    device: Optional[str] = None,
    local_model_dir: Optional[str] = None,
    vad_model_path: Optional[str] = None,
    translation_mode: str = "line_by_line",
    llm_api_config: Optional[Dict[str, Any]] = None,
    force_reprocess: bool = False,
    manual_language: Optional[str] = None,
    manual_is_instrumental: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    """
    Process a single audio file for lyrics.

    Tries to reuse existing lyrics first, otherwise detects language,
    transcribes with Whisper, and translates.

    Parameters
    ----------
    audio_path : str
        Path to the audio file.
    whisper_model_size : str
        Whisper model size.
    device : str or None
        Compute device.
    local_model_dir : str or None
        Local translation model directory.
    vad_model_path : str or None
        VAD model path.
    translation_mode : str
        ``"line_by_line"``, ``"llm"``, or ``"context"``.
    llm_api_config : dict or None
        LLM API config.
    force_reprocess : bool
        If True, skip existing lyrics and force Whisper recognition.
    manual_language : str or None
        Manually specify language ("zh"/"ja"/"ko"/"en").
    manual_is_instrumental : bool or None
        True=force instrumental, False=force has lyrics, None=auto.

    Returns
    -------
    dict or None
        Processing result with segments, language, etc.
    """
    if device is None:
        device = get_device()

    if not force_reprocess:
        existing = safe_check_and_process_existing_lyrics(
            audio_path, local_model_dir, translation_mode,
            llm_api_config, whisper_model_size=whisper_model_size,
        )
        if existing:
            return existing
    else:
        logger.info("force_reprocess=True, skipping existing lyrics check")

    # ---- Manual instrumental flag ----
    if manual_is_instrumental is True:
        logger.info("Manually marked as instrumental, skipping detection and transcription")
        audio_output_dir = os.path.join(os.path.dirname(audio_path), "audio_with_lyrics")
        os.makedirs(audio_output_dir, exist_ok=True)
        base_name = os.path.basename(audio_path)
        name, ext = os.path.splitext(base_name)
        output_path = os.path.join(audio_output_dir, f"{name}{ext}")
        shutil.copy2(audio_path, output_path)
        embed_instrumental_tags(output_path)
        logger.info(f"Instrumental file copied and tagged: {output_path}")
        return {
            "original_text": "",
            "translated_text": "",
            "segments": [],
            "language": "nn",
            "is_bilingual": False,
            "source": "instrumental",
        }

    # ---- Manually specified language: skip detection ----
    if manual_language:
        logger.info(f"Manually specified language: {manual_language}, skipping auto-detection")
        detected_lang = manual_language
    else:
        # ---- Demucs vocal separation for more accurate language detection ----
        vocal_for_detect = None
        vocal_temp_dir = None
        if DEMUCS_AVAILABLE and DEMUCS_CONFIG.get("enabled", True):
            vocal_for_detect = separate_vocals_with_demucs(audio_path)
            if vocal_for_detect:
                vocal_temp_dir = os.path.dirname(vocal_for_detect)

        try:
            detected_lang = detect_language(
                audio_path, whisper_model_size, device,
                vad_model_path, vocal_audio_path=vocal_for_detect,
                manual_language=None,
            )
        finally:
            if vocal_temp_dir and os.path.exists(vocal_temp_dir):
                shutil.rmtree(vocal_temp_dir, ignore_errors=True)

    if detected_lang == "nn":
        logger.info("Detected instrumental, skipping all processing")
        audio_output_dir = os.path.join(os.path.dirname(audio_path), "audio_with_lyrics")
        os.makedirs(audio_output_dir, exist_ok=True)
        base_name = os.path.basename(audio_path)
        name, ext = os.path.splitext(base_name)
        output_path = os.path.join(audio_output_dir, f"{name}{ext}")
        shutil.copy2(audio_path, output_path)
        embed_instrumental_tags(output_path)
        logger.info(f"Instrumental file copied and tagged: {output_path}")
        return {
            "original_text": "",
            "translated_text": "",
            "segments": [],
            "language": "nn",
            "is_bilingual": False,
            "source": "instrumental",
        }

    logger.info("No existing lyrics found, transcribing with Whisper...")
    return transcribe_and_translate_with_lang(
        audio_path, whisper_model_size, device, local_model_dir,
        vad_model_path, translation_mode, llm_api_config, detected_lang,
    )


def transcribe_and_translate_with_lang(
    audio_path: str,
    whisper_model_size: str = "medium",
    device: Optional[str] = None,
    local_model_dir: Optional[str] = None,
    vad_model_path: Optional[str] = None,
    translation_mode: str = "line_by_line",
    llm_api_config: Optional[Dict[str, Any]] = None,
    detected_lang: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Transcribe and translate with known language, using Demucs + VAD smart segmentation.

    Parameters
    ----------
    audio_path : str
        Path to audio file.
    whisper_model_size : str
        Whisper model size.
    device : str or None
        Compute device.
    local_model_dir : str or None
        Translation model directory.
    vad_model_path : str or None
        VAD model path.
    translation_mode : str
        Translation mode.
    llm_api_config : dict or None
        LLM API config.
    detected_lang : str or None
        Pre-detected language code.

    Returns
    -------
    dict or None
        Result with segments, or None on error.
    """
    if device is None:
        device = get_device()
    start_time = time.time()

    try:
        logger.info(f"Starting audio processing, device: {device}")
        if detected_lang:
            logger.info(f"Using pre-detected language: {detected_lang}")
        else:
            detected_lang = detect_language_multi_gpu(
                audio_path, whisper_model_size, device, vad_model_path,
            )

        if detected_lang == "nn":
            logger.info("Detected instrumental, skipping transcription and translation")
            return {
                "original_text": "",
                "translated_text": "",
                "segments": [],
                "language": "nn",
                "is_bilingual": False,
                "source": "instrumental",
                "duration": time.time() - start_time,
            }

        # ---- Demucs vocal separation ----
        vocal_audio = audio_path
        if DEMUCS_AVAILABLE and DEMUCS_CONFIG.get("enabled", True):
            vocal_audio = separate_vocals_with_demucs(audio_path) or audio_path
        else:
            logger.info("Demucs not enabled, using raw audio for recognition")

        # Vocal normalization (Demucs output can be quiet)
        if vocal_audio != audio_path:
            try:
                wav, sr = torchaudio.load(vocal_audio)
                peak = wav.abs().max().item()
                if 0 < peak < 0.1:
                    gain = 0.9 / peak
                    torchaudio.save(vocal_audio, wav * gain, sr)
                    logger.info(
                        f"Vocal normalization: peak {peak:.4f} → 0.9 (gain {gain:.1f}x)"
                    )
                else:
                    logger.info(f"Vocal level normal (peak {peak:.3f}), skipping normalization")
            except Exception as e:
                logger.debug(f"Vocal normalization skipped: {e}")

        # ---- Whisper transcription ----
        logger.info("Step 2: Whisper lyric recognition")
        whisper_model = load_whisper_model(whisper_model_size, device)
        whisper_options = {
            "language": detected_lang,
            "task": "transcribe",
            "fp16": True,
            "verbose": False,
            "temperature": [0.0, 0.2, 0.4, 0.6, 0.8],
            "best_of": 5,
            "beam_size": 5,
            "patience": 1.0,
            "condition_on_previous_text": False,
            "compression_ratio_threshold": 5.0,
            "logprob_threshold": None,
            "no_speech_threshold": 0.2,
            "suppress_tokens": "",
            "initial_prompt": "歌詞",
        }

        logger.info(f"VAD smart-segmented transcription: {vocal_audio}")
        vad_whisper_options = dict(whisper_options)
        vad_whisper_options["no_speech_threshold"] = 1
        vad_whisper_options.pop("initial_prompt", None)
        transcription = _transcribe_vad_guided(
            whisper_model, vocal_audio, vad_whisper_options,
            vad_pipeline=_get_vad_pipeline(),
        )

        del whisper_model
        cleanup_gpu()
        _release_vad_pipeline()

        # Clean up Demucs temp files
        if (
            vocal_audio != audio_path
            and DEMUCS_CONFIG.get("cleanup_temp", True)
            and os.path.exists(vocal_audio)
        ):
            vocal_dir = os.path.dirname(vocal_audio)
            if vocal_dir.startswith(tempfile.gettempdir()):
                shutil.rmtree(vocal_dir, ignore_errors=True)

        # ---- Translation ----
        if detected_lang != "zh":
            raw_segments = transcription["segments"]
            if translation_mode == "llm" and llm_api_config:
                lyrics_data = [
                    (int(seg["start"] * 1000), seg["text"]) for seg in raw_segments
                ]
                return translate_with_llm_api(
                    lyrics_data, llm_api_config, audio_path, local_model_dir,
                )
            return translate_with_local_model_multi_gpu(
                transcription, detected_lang, local_model_dir, device,
            )
        else:
            segments = [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "original_text": seg["text"],
                    "translated_text": seg["text"],
                }
                for seg in transcription["segments"]
            ]
            return {
                "original_text": transcription["text"],
                "translated_text": transcription["text"],
                "segments": segments,
                "language": detected_lang,
                "duration": time.time() - start_time,
            }
    except Exception as e:
        logger.error(f"Processing error: {e}")
        logger.error(traceback.format_exc())
        return None
    finally:
        cleanup_gpu()
        _release_vad_pipeline()


def transcribe_and_translate(
    audio_path: str,
    whisper_model_size: str = "medium",
    device: Optional[str] = None,
    local_model_dir: Optional[str] = None,
    vad_model_path: Optional[str] = None,
    translation_mode: str = "line_by_line",
    llm_api_config: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Transcribe and translate (single-pass version, no Demucs/VAD segmentation).

    This is a simpler alternative to the VAD-guided pipeline.

    Parameters
    ----------
    audio_path : str
        Path to audio file.
    whisper_model_size : str
        Whisper model size.
    device : str or None
        Compute device.
    local_model_dir : str or None
        Translation model directory.
    vad_model_path : str or None
        VAD model path.
    translation_mode : str
        Translation mode.
    llm_api_config : dict or None
        LLM API config.

    Returns
    -------
    dict or None
        Processing result.
    """
    if device is None:
        device = get_device()
    start_time = time.time()
    try:
        logger.info(f"Starting audio processing, device: {device}")
        detected_lang = detect_language_multi_gpu(
            audio_path, whisper_model_size, device, vad_model_path,
        )
        if detected_lang == "nn":
            return {
                "original_text": "",
                "translated_text": "",
                "segments": [],
                "language": "nn",
                "is_bilingual": False,
                "source": "instrumental",
                "duration": time.time() - start_time,
            }

        whisper_model = load_whisper_model(whisper_model_size, device)
        whisper_options = {
            "language": detected_lang,
            "task": "transcribe",
            "fp16": True,
            "verbose": False,
            "temperature": [0.0, 0.2, 0.4, 0.6, 0.8],
            "best_of": 5,
            "beam_size": 5,
            "patience": 1.0,
            "condition_on_previous_text": False,
            "compression_ratio_threshold": 5.0,
            "logprob_threshold": None,
            "no_speech_threshold": 0.2,
            "suppress_tokens": "",
            "initial_prompt": "歌詞",
        }
        logger.info(f"Transcribing: {audio_path}")
        transcription = whisper_model.transcribe(audio_path, **whisper_options)
        del whisper_model
        cleanup_gpu()

        if detected_lang != "zh":
            if translation_mode == "llm" and llm_api_config:
                lyrics_data = [
                    (int(seg["start"] * 1000), seg["text"])
                    for seg in transcription["segments"]
                ]
                return translate_with_llm_api(
                    lyrics_data, llm_api_config, audio_path, local_model_dir,
                )
            return translate_with_local_model_multi_gpu(
                transcription, detected_lang, local_model_dir, device,
            )
        else:
            segments = [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "original_text": seg["text"],
                    "translated_text": seg["text"],
                }
                for seg in transcription["segments"]
            ]
            return {
                "original_text": transcription["text"],
                "translated_text": transcription["text"],
                "segments": segments,
                "language": detected_lang,
                "duration": time.time() - start_time,
            }
    except Exception as e:
        logger.error(f"Processing error: {e}")
        logger.error(traceback.format_exc())
        return None
    finally:
        cleanup_gpu()


# ============================================================================
# LRC Generation / Saving
# ============================================================================


def format_time(seconds: float) -> str:
    """Convert seconds to LRC timestamp (mm:ss.hundredths)."""
    minutes = int(seconds // 60)
    seconds = seconds % 60
    return f"{minutes:02d}:{seconds:06.3f}".replace(".", ":")


def create_lrc_content(
    segments: List[Dict[str, Any]], bilingual: bool = False, original_lang: str = "ja"
) -> str:
    """Generate LRC content from segments. Bilingual mode concatenates original+translation."""
    lrc_lines = []
    for segment in segments:
        start_time = format_time(segment["start"])
        if bilingual and "original_text" in segment:
            bilingual_text = f"{segment['original_text']}\n{segment['translated_text']}"
            lrc_lines.append(f"[{start_time}]{bilingual_text}")
        else:
            lrc_lines.append(f"[{start_time}]{segment['translated_text']}")
    return "\n".join(lrc_lines)


def save_lrc_file(
    audio_path: str,
    segments: List[Dict[str, Any]],
    bilingual: bool = False,
    original_lang: str = "ja",
) -> Optional[str]:
    """Save LRC file to ``lrc_output`` directory beside the audio file."""
    try:
        base_name = os.path.basename(audio_path)
        name, _ = os.path.splitext(base_name)
        lrc_output_dir = os.path.join(os.path.dirname(audio_path), "lrc_output")
        os.makedirs(lrc_output_dir, exist_ok=True)
        lrc_output_path = os.path.join(lrc_output_dir, f"{name}.lrc")
        lrc_content = create_lrc_content(segments, bilingual, original_lang)
        with open(lrc_output_path, "w", encoding="utf-8") as f:
            f.write(lrc_content)
        logger.info(f"LRC file saved to: {lrc_output_path}")
        return lrc_output_path
    except Exception as e:
        logger.error(f"Error saving LRC file: {e}")
        logger.error(traceback.format_exc())
        return None


# ============================================================================
# Lyrics Tag Checking / Debug Output
# ============================================================================


def check_embedded_lyrics(audio_path: str) -> Tuple[bool, str, Dict[str, Any]]:
    """
    Check if an audio file has embedded lyrics.

    Returns
    -------
    tuple
        ``(has_lyrics: bool, lyrics_type: str, lyrics_info: dict)``
    """
    audio = MutagenFile(audio_path)
    if audio is None:
        return False, "Unrecognized audio file", {}

    lyrics_info = {}
    if audio.tags and isinstance(audio.tags, ID3):
        sylt_frames = audio.tags.getall("SYLT")
        if sylt_frames:
            lyrics_info["SYLT"] = {
                "type": "SYLT (synchronized lyrics)",
                "count": len(sylt_frames),
                "content": sylt_frames[0].text if sylt_frames[0].text else None,
                "description": getattr(sylt_frames[0], "desc", "N/A"),
                "language": getattr(sylt_frames[0], "lang", "N/A"),
            }
        uslt_frames = audio.tags.getall("USLT")
        if uslt_frames:
            lyrics_info["USLT"] = {
                "type": "USLT (unsynchronized text lyrics)",
                "count": len(uslt_frames),
                "content": (
                    uslt_frames[0].text if hasattr(uslt_frames[0], "text") else None
                ),
                "description": getattr(uslt_frames[0], "desc", "N/A"),
                "language": getattr(uslt_frames[0], "lang", "N/A"),
            }
        for frame in audio.tags.getall("TXXX"):
            if hasattr(frame, "desc") and "lyric" in frame.desc.lower():
                key = f"TXXX:{frame.desc}"
                lyrics_info[key] = {
                    "type": f"TXXX (custom lyric tag: {frame.desc})",
                    "count": 1,
                    "content": getattr(frame, "text", None),
                    "description": frame.desc,
                    "language": "N/A",
                }
    elif isinstance(audio, FLAC) and audio.tags:
        lyric_fields = [
            "LYRICS", "lyrics", "LYRIC", "lyric",
            "SYNCED LYRICS", "SYNCED_LYRICS", "slyrics", "SLYRICS",
        ]
        for field in lyric_fields:
            if field in audio.tags:
                lyrics_info[field] = {
                    "type": f"{field} (Vorbis comment)",
                    "count": len(audio.tags[field]),
                    "content": (
                        "\n".join(audio.tags[field]) if audio.tags[field] else None
                    ),
                    "description": field,
                    "language": "N/A",
                }

    has = len(lyrics_info) > 0
    if has:
        if len(lyrics_info) > 1:
            lyric_type = "Multiple lyric tag types"
        else:
            lyric_type = next(iter(lyrics_info.values()))["type"]
    else:
        lyric_type = "No lyrics"
    return has, lyric_type, lyrics_info


def print_sylt_details(sylt_data: List[Tuple[str, int]]) -> None:
    """Print SYLT content (first 10 lines)."""
    if not sylt_data:
        print("No SYLT data")
        return
    print(f"Total {len(sylt_data)} synchronized lyric lines:")
    for i, (text, timestamp) in enumerate(sylt_data[:10]):
        minutes = timestamp // 60000
        seconds = (timestamp % 60000) // 1000
        milliseconds = timestamp % 1000
        display_text = repr(text) if "\n" in text else text
        print(f"  [{minutes:02d}:{seconds:02d}.{milliseconds:03d}] {display_text}")
    if len(sylt_data) > 10:
        print(f"  ... {len(sylt_data) - 10} more lines")


def print_lyrics_details(lyrics_info: Dict[str, Any]) -> None:
    """Print detailed info for all lyric tags found."""
    if not lyrics_info:
        print("No lyric tags found")
        return
    print(f"Found {len(lyrics_info)} lyric tag type(s):")
    print("=" * 50)
    for tag_key, info in lyrics_info.items():
        print(f"Tag type: {info['type']}")
        print(f"  Count: {info['count']}")
        print(f"  Description: {info['description']}")
        print(f"  Language: {info['language']}")
        if info["content"]:
            if tag_key == "SYLT":
                print("  Content preview:")
                print_sylt_details(info["content"])
            else:
                content = info["content"]
                if isinstance(content, list):
                    content = "\n".join(content)
                lines = content.split("\n") if content else []
                print(f"  Content lines: {len(lines)}")
                print("  Preview (first 5 lines):")
                for i, line in enumerate(lines[:5]):
                    if len(line) > 50:
                        print(f"    {line[:50]}...")
                    else:
                        print(f"    {line}")
                if len(lines) > 5:
                    print(f"    ... {len(lines) - 5} more lines")
        else:
            print("  Content: None")
        print("-" * 30)


def parse_lrc(lrc_path: str) -> List[Tuple[int, str]]:
    """Parse a .lrc file and return sorted (timestamp_ms, text) pairs."""
    lyrics = []
    with open(lrc_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m1 = _TIMESTAMP_PATTERN_DOT.match(line)
            m2 = _TIMESTAMP_PATTERN_COLON.match(line)
            if m1:
                mins, secs, ms, text = m1.groups()
                ms_value = int(ms)
                if len(ms) == 2:
                    ms_value *= 10
                ts = (int(mins) * 60 + int(secs)) * 1000 + ms_value
                if (
                    text.strip()
                    and not text.strip().startswith("作詞")
                    and len(text.strip()) > 1
                ):
                    lyrics.append((ts, text.strip()))
            elif m2:
                mins, secs, ms, text = m2.groups()
                ts = (int(mins) * 60 + int(secs)) * 1000 + int(ms)
                if (
                    text.strip()
                    and not text.strip().startswith("作詞")
                    and len(text.strip()) > 1
                ):
                    lyrics.append((ts, text.strip()))
    sorted_lyrics = sorted(lyrics, key=lambda x: x[0])
    print(f"Parse details: {len(sorted_lyrics)} valid lyric lines")
    return sorted_lyrics


# ============================================================================
# Lyrics Embedding (MP3 / FLAC)
# ============================================================================


def embed_sylt_and_uslt(
    audio_path: str,
    lrc_path: str,
    output_dir: str,
    is_bilingual: bool = False,
    segments: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """
    Embed lyrics as SYLT + USLT into audio file, output to a given directory.

    Parameters
    ----------
    audio_path : str
        Path to source audio.
    lrc_path : str
        Path to LRC file (used if bilingual segments not provided).
    output_dir : str
        Output directory.
    is_bilingual : bool
        Whether the lyrics are bilingual.
    segments : list of dict or None
        Bilingual segment data (overrides LRC parsing).

    Returns
    -------
    str
        Path to the output file with embedded lyrics.
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    if not os.path.exists(lrc_path):
        raise FileNotFoundError(f"Lyric file not found: {lrc_path}")
    os.makedirs(output_dir, exist_ok=True)

    base_name = os.path.basename(audio_path)
    name, ext = os.path.splitext(base_name)
    output_path = os.path.join(output_dir, f"{name}{ext}")
    shutil.copy2(audio_path, output_path)

    if is_bilingual and segments:
        logger.info("Using bilingual segment data")
        lyrics_data = []
        for segment in segments:
            ts = int(segment["start"] * 1000)
            if "original_text" in segment and "translated_text" in segment:
                lyrics_data.append(
                    (ts, f"{segment['original_text']}\n{segment['translated_text']}")
                )
            else:
                lyrics_data.append((ts, segment["translated_text"]))
    else:
        lyrics_data = parse_lrc(lrc_path)
        logger.info(f"Parsed lyrics from LRC: {len(lyrics_data)} lines")
        if len(lyrics_data) == 0:
            logger.warning("No lyrics parsed, check LRC format")
            return output_path

    if output_path.lower().endswith(".mp3"):
        embed_sylt_and_uslt_mp3(output_path, lyrics_data, is_bilingual)
    elif output_path.lower().endswith(".flac"):
        embed_sylt_and_uslt_flac(output_path, lyrics_data, is_bilingual)
    else:
        raise ValueError(f"Unsupported format, only MP3/FLAC supported: {output_path}")

    logger.info(f"Lyric embedding complete: {output_path}")
    return output_path


def embed_sylt_and_uslt_mp3(
    mp3_path: str, lyrics_data: List[Tuple[int, str]], is_bilingual: bool = False
) -> None:
    """Embed both SYLT and USLT into an MP3 file (with auto-repair)."""
    from mutagen.id3._util import ID3NoHeaderError

    repair_attempted = False
    while True:
        try:
            audio = ID3(mp3_path)
            break
        except ID3NoHeaderError:
            if not repair_attempted:
                logger.info(f"Detected MP3 header error, attempting repair: {mp3_path}")
                ok, _, err = repair_mp3_file(mp3_path)
                if ok:
                    repair_attempted = True
                    continue
                logger.error(f"Repair failed: {err}")
                raise
            logger.error("Already attempted repair, giving up")
            raise
        except Exception as e:
            logger.error(f"Unknown error reading MP3: {e}")
            raise

    # Group by timestamp
    timestamp_groups: Dict[int, List[str]] = {}
    for ts, text in lyrics_data:
        if text.strip():
            timestamp_groups.setdefault(ts, []).append(text.strip())

    sylt_data = []
    for ts in sorted(timestamp_groups.keys()):
        combined = "\n".join(timestamp_groups[ts])
        sylt_data.append((combined, ts))

    # Fix non-strictly-increasing timestamps
    for i in range(1, len(sylt_data)):
        if sylt_data[i][1] <= sylt_data[i - 1][1]:
            sylt_data[i] = (sylt_data[i][0], sylt_data[i - 1][1] + 100)

    sylt = SYLT(
        encoding=Encoding.UTF8,
        format=2,
        type=1,
        desc="Synced Lyrics",
        lang="eng",
        text=sylt_data,
    )

    full_lyrics = []
    for ts, text in sorted(lyrics_data, key=lambda x: x[0]):
        full_lyrics.append(f"{_format_timestamp(ts)} {text}")
    uslt = USLT(
        encoding=Encoding.UTF8,
        lang="eng",
        desc="Unsynchronized Lyrics",
        text="\n".join(full_lyrics),
    )

    audio.delall("SYLT")
    audio.delall("USLT")
    audio.add(sylt)
    audio.add(uslt)
    audio.save(v2_version=3)
    logger.info("MP3 lyric embedding successful (SYLT + USLT)")


def embed_sylt_and_uslt_flac(
    flac_path: str, lyrics_data: List[Tuple[int, str]], is_bilingual: bool = False
) -> None:
    """Embed both synchronized and unsynchronized lyrics into a FLAC file."""
    audio = FLAC(flac_path)

    timestamp_groups: Dict[int, List[str]] = {}
    for ts, text in lyrics_data:
        if text.strip():
            timestamp_groups.setdefault(ts, []).append(text.strip())

    processed_lyrics = {
        ts: "\n".join(timestamp_groups[ts]) for ts in sorted(timestamp_groups.keys())
    }

    synced_lyrics = []
    for ts in sorted(processed_lyrics.keys()):
        text = processed_lyrics[ts]
        if text.strip():
            synced_lyrics.append(f"{_format_timestamp(ts)}{text}")

    full_lyrics = []
    for ts, text in sorted(lyrics_data, key=lambda x: x[0]):
        full_lyrics.append(f"{_format_timestamp(ts)} {text}")
    unsynced_lyrics = "\n".join(full_lyrics)

    if synced_lyrics:
        audio["SYNCED_LYRICS"] = "\n".join(synced_lyrics)
        logger.info(f"Added synchronized lyrics to FLAC ({len(synced_lyrics)} lines)")
    if unsynced_lyrics:
        audio["LYRICS"] = unsynced_lyrics
        logger.info("Added unsynchronized lyrics to FLAC")

    logger.info("Adding chapter navigation...")
    add_flac_chapters(audio, list(processed_lyrics.items()))
    audio.save()
    logger.info("FLAC lyric embedding successful (synced + unsynced)")


def add_flac_chapters(flac_audio: FLAC, lyrics: List[Tuple[int, str]]) -> None:
    """Add chapter navigation to FLAC file."""
    chapters = []
    sorted_lyrics = sorted(lyrics, key=lambda x: x[0])
    for i, (ts, text) in enumerate(sorted_lyrics):
        start_time = ts / 1000.0
        if i < len(sorted_lyrics) - 1:
            end_time = sorted_lyrics[i + 1][0] / 1000.0
        else:
            end_time = start_time + 10.0
        chapters.append({"title": text, "start_time": start_time, "end_time": end_time})
    if chapters:
        flac_audio["CHAPTERS"] = json.dumps(chapters, ensure_ascii=False)
        logger.info(f"Added {len(chapters)} FLAC chapters")
    else:
        logger.info("No chapters added (no valid chapter data)")


def add_chapter_navigation(audio: ID3, lyrics: List[Tuple[int, str]]) -> None:
    """Add chapter navigation (CTOC) to an MP3 file."""
    unique_lyrics = []
    seen_timestamps: set = set()
    for ts, text in lyrics:
        if ts not in seen_timestamps:
            unique_lyrics.append((ts, text))
            seen_timestamps.add(ts)

    chapter_ids = []
    for i, (ts, text) in enumerate(unique_lyrics):
        chap_id = f"chp{i}"
        chapter_ids.append(chap_id)
        if i < len(unique_lyrics) - 1:
            end_time = unique_lyrics[i + 1][0]
        else:
            end_time = ts + 10000
        if end_time <= ts:
            end_time = ts + 5000
        try:
            chap = CHAP(element_id=chap_id, start_time=ts, end_time=end_time)
            chap.sub_frames["TIT2"] = TIT2(encoding=Encoding.UTF8, text=text)
            audio.add(chap)
        except Exception as e:
            logger.info(f"Error creating chapter: {e}")
            continue

    if chapter_ids:
        try:
            ctoc = CTOC(
                element_id="toc1",
                flags=CTOCFlags.TOP_LEVEL | CTOCFlags.ORDERED,
                child_element_ids=chapter_ids,
                description="Lyrics Chapters",
            )
            audio.add(ctoc)
            logger.info(f"Added {len(chapter_ids)} chapters")
        except Exception as e:
            logger.info(f"Error creating chapter table of contents: {e}")
    else:
        logger.info("No chapters added (no valid chapter data)")


def save_results(
    audio_path: str, result: Dict[str, Any]
) -> Tuple[Optional[str], Optional[str]]:
    """
    Save processing results: LRC file and audio with embedded lyrics.

    For instrumental files, just returns the output path.

    Returns
    -------
    tuple
        ``(lrc_path: str or None, audio_output_path: str or None)``
    """
    try:
        if result.get("language") == "nn" and result.get("source") == "instrumental":
            audio_output_dir = os.path.join(
                os.path.dirname(audio_path), "audio_with_lyrics"
            )
            base_name = os.path.basename(audio_path)
            name, ext = os.path.splitext(base_name)
            output_path = os.path.join(audio_output_dir, f"{name}{ext}")
            logger.info(f"Instrumental file exists at: {output_path}")
            return None, output_path

        audio_output_dir = os.path.join(
            os.path.dirname(audio_path), "audio_with_lyrics"
        )
        os.makedirs(audio_output_dir, exist_ok=True)
        is_bilingual = result.get("language", "zh") != "zh" or result.get(
            "is_bilingual", False
        )

        lrc_path = save_lrc_file(
            audio_path,
            result["segments"],
            bilingual=is_bilingual,
            original_lang=result.get("language", "unknown"),
        )
        if not lrc_path:
            logger.error("Failed to save LRC file")
            return None, None

        logger.info("Embedding lyrics into audio...")
        audio_output = embed_sylt_and_uslt(
            audio_path, lrc_path, audio_output_dir, is_bilingual, result["segments"]
        )
        if not audio_output or not os.path.exists(audio_output):
            logger.error("Lyric embedding failed")
            return lrc_path, None

        has_lyrics, lyric_type, _ = check_embedded_lyrics(audio_output)
        if has_lyrics:
            logger.info(f"Verification passed: embedded lyrics found! Type: {lyric_type}")
        else:
            logger.warning("Verification failed: no embedded lyrics found")

        return lrc_path, audio_output
    except Exception as e:
        logger.error(f"Error saving results: {e}")
        logger.error(traceback.format_exc())
        return None, None


# ============================================================================
# Context-Aware Translation (whole song + line markers)
# ============================================================================


def process_lyrics_with_translation_context(
    lyrics_data: List[Tuple[int, str]],
    audio_path: str,
    local_model_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Context-aware translation: translate whole song at once with line markers,
    then split back to individual lines.

    Parameters
    ----------
    lyrics_data : list of (int, str)
        Timestamped lyrics.
    audio_path : str
        Path to audio file.
    local_model_dir : str or None
        Local translation model directory.

    Returns
    -------
    dict
        Segments result.
    """
    detected_lang = detect_language(audio_path, "medium")
    logger.info(f"Detected lyric language: {detected_lang}")

    if detected_lang == "zh":
        segments = [
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": text,
                "translated_text": text,
            }
            for ts, text in lyrics_data
        ]
        return {
            "segments": segments,
            "language": detected_lang,
            "is_bilingual": False,
            "source": "existing_chinese",
        }

    logger.info("Translating lyrics (context mode)...")
    device = get_device()
    tokenizer, model, model_config = _load_translation_model_for_processing(
        local_model_dir, device
    )
    _, tgt_lang = _configure_tokenizer_lang(tokenizer, model_config, detected_lang)
    forced_bos_id = _get_forced_bos_id(tokenizer, tgt_lang, model_config["is_nllb"])

    original_texts = [text for _, text in lyrics_data]
    marked_lines = [f"[LINE_{i:03d}]{text}" for i, text in enumerate(original_texts)]
    combined_text = "\n".join(marked_lines)

    translated_parts = []
    try:
        encoded = tokenizer(combined_text, return_tensors="pt", padding=True).to(device)
        generated = _generate_translation(
            model,
            encoded,
            forced_bos_id,
            max_length=4096,
            length_penalty=1.0,
            no_repeat_ngram_size=3,
        )
        translated_combined = tokenizer.batch_decode(
            generated, skip_special_tokens=True
        )[0]

        line_pattern = re.compile(r"\[LINE_(\d+)\](.*?)(?=\[LINE_\d+\]|$)", re.DOTALL)
        matches = line_pattern.findall(translated_combined)
        if matches:
            matches.sort(key=lambda x: int(x[0]))
            translated_parts = [m[1].strip() for m in matches]
            if len(translated_parts) != len(original_texts):
                logger.warning(
                    f"Marked translation line count mismatch: {len(translated_parts)} vs {len(original_texts)}"
                )
                translated_parts = []
        else:
            logger.warning("No markers found, trying line split...")
            translated_parts = [
                line.strip() for line in translated_combined.split("\n") if line.strip()
            ]
            if len(translated_parts) != len(original_texts):
                translated_parts = smart_split_text(
                    translated_combined, len(original_texts)
                )
    except Exception as e:
        logger.error(f"Combined translation failed: {e}")
        logger.info("Falling back to line-by-line translation mode...")
        translated_parts = []

    segments = []
    for i, (ts, original_text) in enumerate(lyrics_data):
        is_metadata = (
            original_text.strip().startswith(("作词", "作曲", "編曲", "歌手"))
            or len(original_text.strip()) <= 3
        )
        if is_metadata:
            translated_text = original_text
        elif translated_parts and i < len(translated_parts):
            translated_text = translated_parts[i]
        else:
            translated_text = translate_single_line(
                original_text, tokenizer, model, tgt_lang, model_config
            )
        segments.append(
            {
                "start": ts / 1000.0,
                "end": ts / 1000.0 + 3.0,
                "original_text": original_text,
                "translated_text": translated_text,
            }
        )

    _convert_traditional_to_simplified(segments)
    del model
    cleanup_gpu()
    return {
        "segments": segments,
        "language": detected_lang,
        "is_bilingual": True,
        "source": "translated_context",
    }


def translate_single_line(
    text: str, tokenizer: Any, model: nn.Module, tgt_lang: str, model_config: Dict[str, Any]
) -> str:
    """Single-line translation fallback for context mode."""
    try:
        device = next(model.parameters()).device
        encoded = tokenizer(text, return_tensors="pt", padding=True).to(device)
        forced_bos_id = _get_forced_bos_id(tokenizer, tgt_lang, model_config["is_nllb"])
        generated = _generate_translation(model, encoded, forced_bos_id, num_beams=3)
        return tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
    except Exception as e:
        logger.warning(f"Single-line translation failed: {text}, error: {e}")
        return text


def smart_split_text(translated_text: str, num_parts: int) -> List[str]:
    """Smart-split translated text into the specified number of parts."""
    if num_parts <= 1:
        return [translated_text]
    sentences = re.split(r"[。！？.!?]+", translated_text)
    sentences = [s.strip() for s in sentences if s.strip()]
    if len(sentences) >= num_parts:
        per_part = len(sentences) // num_parts
        remainder = len(sentences) % num_parts
        parts = []
        idx = 0
        for i in range(num_parts):
            count = per_part + (1 if i < remainder else 0)
            parts.append("".join(sentences[idx : idx + count]))
            idx += count
        return parts
    total_chars = len(translated_text)
    chars_per_part = total_chars // num_parts
    parts = []
    for i in range(num_parts):
        start = i * chars_per_part
        end = total_chars if i == num_parts - 1 else (i + 1) * chars_per_part
        parts.append(translated_text[start:end].strip())
    return parts


# ============================================================================
# Batch Processing Entry (mode 2)
# ============================================================================


def process_files_and_folders(
    input_paths: List[str],
    whisper_model_size: str = "medium",
    local_model_dir: Optional[str] = None,
    translation_mode: str = "line_by_line",
    vad_model_path: Optional[str] = None,
    llm_api_config: Optional[Dict[str, Any]] = None,
    cover_config: Optional[Dict[str, Any]] = None,
    force_reprocess: bool = False,
    manual_language: Optional[str] = None,
    manual_is_instrumental: Optional[bool] = None,
) -> Optional[List[Dict[str, Any]]]:
    """
    Process audio files in file/folder lists (mode 2 batch orchestrator).

    Skips already-processed files and output directories. When
    ``force_reprocess=True``, existing lyrics are ignored.

    Parameters
    ----------
    input_paths : list of str
        List of file or directory paths.
    whisper_model_size : str
        Whisper model size.
    local_model_dir : str or None
        Local translation model directory.
    translation_mode : str
        Translation mode.
    vad_model_path : str or None
        VAD model path.
    llm_api_config : dict or None
        LLM API configuration.
    cover_config : dict or None
        Cover art configuration.
    force_reprocess : bool
        Force re-recognition and translation.
    manual_language : str or None
        Manually specified language.
    manual_is_instrumental : bool or None
        Manually flag as instrumental.

    Returns
    -------
    list of dict or None
        List of per-file results.
    """
    audio_files: List[str] = []

    for path in input_paths:
        if os.path.isfile(path):
            if path.lower().endswith(SUPPORTED_AUDIO_EXTENSIONS):
                if not force_reprocess and check_output_file_complete(path):
                    logger.info(f"Skipping already-processed file: {path}")
                else:
                    audio_files.append(path)
            else:
                logger.warning(f"Skipping non-audio file: {path}")
        elif os.path.isdir(path):
            for root, dirs, files in os.walk(path):
                if "audio_with_lyrics" in dirs:
                    dirs.remove("audio_with_lyrics")
                dirs[:] = [d for d in dirs if "audio_with_lyrics" not in d]
                for file in files:
                    if file.lower().endswith(SUPPORTED_AUDIO_EXTENSIONS):
                        full_path = os.path.join(root, file)
                        if not force_reprocess and check_output_file_complete(full_path):
                            logger.info(f"Skipping already-processed file: {full_path}")
                        else:
                            audio_files.append(full_path)
        else:
            logger.warning(f"Path does not exist: {path}")

    if not audio_files:
        logger.error("No audio files found to process")
        return None

    logger.info(f"Found {len(audio_files)} audio file(s) to process")
    logger.info("Checking and converting M4A files...")
    audio_files = process_m4a_files(audio_files)
    logger.info(f"After M4A processing, {len(audio_files)} audio file(s) remain")

    original_process_func = None
    if translation_mode == "context":
        original_process_func = globals()["process_lyrics_with_translation"]
        globals()["process_lyrics_with_translation"] = process_lyrics_with_translation_context

    results = []
    try:
        for i, audio_file in enumerate(audio_files, 1):
            logger.info(f"Processing file {i}/{len(audio_files)}: {audio_file}")
            try:
                result = process_audio_file(
                    audio_file,
                    whisper_model_size=whisper_model_size,
                    local_model_dir=local_model_dir,
                    vad_model_path=vad_model_path,
                    translation_mode=translation_mode,
                    llm_api_config=llm_api_config,
                    force_reprocess=force_reprocess,
                    manual_language=manual_language,
                    manual_is_instrumental=manual_is_instrumental,
                )
                if result:
                    lrc_path, audio_out_path = save_results(audio_file, result)
                    if (
                        audio_out_path
                        and cover_config
                        and cover_config.get("enabled", True)
                    ):
                        cover_image_path = find_cover_image(audio_file, cover_config)
                        if cover_image_path:
                            set_audio_cover(audio_out_path, cover_image_path, cover_config)
                        else:
                            logger.info("No cover image found, skipping cover embedding")
                    results.append(
                        {
                            "file": audio_file,
                            "lrc_path": lrc_path,
                            "audio_path": audio_out_path,
                            "success": True,
                        }
                    )
                    logger.info(f"File processing complete: {audio_file}")
                else:
                    logger.error(f"File processing failed: {audio_file}")
                    results.append(
                        {
                            "file": audio_file,
                            "lrc_path": None,
                            "audio_path": None,
                            "success": False,
                        }
                    )
            except Exception as e:
                logger.error(f"Error processing {audio_file}: {e}")
                logger.error(traceback.format_exc())
                results.append(
                    {
                        "file": audio_file,
                        "lrc_path": None,
                        "audio_path": None,
                        "success": False,
                    }
                )
    finally:
        if translation_mode == "context" and original_process_func:
            globals()["process_lyrics_with_translation"] = original_process_func

    successful = sum(1 for r in results if r["success"])
    failed = len(results) - successful
    logger.info("=" * 60)
    logger.info("Processing summary:")
    logger.info(f"  Total files: {len(results)}")
    logger.info(f"  Successful:  {successful}")
    logger.info(f"  Failed:      {failed}")
    logger.info("=" * 60)
    if failed > 0:
        logger.info("Failed files:")
        for r in results:
            if not r["success"]:
                logger.info(f"  - {r['file']}")
    return results


# ============================================================================
# VAD Vocal Extraction
# ============================================================================


def extract_vocal_with_webrtcvad(
    audio_path: str, output_path: Optional[str] = None
) -> Any:
    """Extract vocals using webrtcvad (pure CPU local fallback)."""
    try:
        logger.info("Extracting vocals with webrtcvad...")
        waveform, sample_rate = torchaudio.load(audio_path)
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if sample_rate != 16000:
            waveform = torchaudio.transforms.Resample(
                orig_freq=sample_rate, new_freq=16000
            )(waveform)
            sample_rate = 16000
        audio_data = (waveform.numpy() * 32767).astype(np.int16)

        vad = webrtcvad.Vad()
        vad.set_mode(3)
        frame_duration = 30
        frame_size = int(sample_rate * frame_duration / 1000)

        vocal_audio = np.zeros_like(audio_data)
        for i in range(0, len(audio_data[0]), frame_size):
            frame = audio_data[0, i : i + frame_size]
            if len(frame) < frame_size:
                continue
            if vad.is_speech(frame.tobytes(), sample_rate):
                vocal_audio[0, i : i + frame_size] = frame

        if output_path:
            vocal_audio_float = vocal_audio.astype(np.float32) / 32767.0
            torchaudio.save(
                output_path, torch.from_numpy(vocal_audio_float), sample_rate
            )
            logger.info(f"Vocal extraction complete, saved to: {output_path}")
            return output_path
        return vocal_audio.astype(np.float32) / 32767.0
    except Exception as e:
        logger.warning(f"webrtcvad processing failed: {e}, using raw audio")
        return audio_path


def extract_vocal_with_vad(
    audio_path: str,
    output_path: Optional[str] = None,
    vad_model_path: Optional[str] = None,
) -> Any:
    """Extract vocals with VAD: prefers pyannote, falls back to webrtcvad."""
    try:
        logger.info("Loading VAD model...")
        os.environ.setdefault("HF_ENDPOINT", VAD_MODEL_CONFIG["hf_mirror"])
        model_dir = vad_model_path or VAD_MODEL_CONFIG["local_path"]
        model_name = VAD_MODEL_CONFIG["model_name"]
        vad_pipeline = None

        if model_dir:
            local_bin = os.path.join(model_dir, "pytorch_model.bin")
            if os.path.isfile(local_bin):
                try:
                    from pyannote.audio import Model

                    vad_model = Model.from_pretrained(local_bin, strict=False)
                    vad_pipeline = VoiceActivityDetection(segmentation=vad_model)
                    vad_pipeline.instantiate(
                        {
                            "onset": 0.5,
                            "offset": 0.5,
                            "min_duration_on": 0.0,
                            "min_duration_off": 0.0,
                        }
                    )
                    logger.info("Local VAD model loaded successfully")
                except Exception as local_e:
                    logger.warning(f"Local VAD load failed: {local_e}")

        if vad_pipeline is None:
            try:
                from pyannote.audio import Pipeline

                vad_pipeline = Pipeline.from_pretrained(
                    model_name, use_auth_token=False
                )
                logger.info("Online VAD model loaded successfully")
            except Exception as online_e:
                logger.warning(f"Online VAD load failed: {online_e}")

        if vad_pipeline is None:
            logger.warning("pyannote VAD unavailable, falling back to webrtcvad")
            return extract_vocal_with_webrtcvad(audio_path, output_path)

        logger.info("Analyzing voice activity in audio...")
        vad_result = vad_pipeline(audio_path)
        waveform, sample_rate = torchaudio.load(audio_path)
        vocal_audio = torch.zeros_like(waveform)
        for region in vad_result.get_timeline().support():
            start_sample = int(region.start * sample_rate)
            end_sample = int(region.end * sample_rate)
            vocal_audio[:, start_sample:end_sample] = waveform[
                :, start_sample:end_sample
            ]

        if output_path:
            torchaudio.save(output_path, vocal_audio, sample_rate)
            logger.info(f"Vocal extraction complete, saved to: {output_path}")
            return output_path
        return vocal_audio.numpy()
    except Exception as e:
        logger.warning(f"VAD processing failed: {e}, falling back to webrtcvad")
        return extract_vocal_with_webrtcvad(audio_path, output_path)


# ============================================================================
# Cover Art Processing
# ============================================================================


def find_cover_image(
    audio_path: str, cover_config: Dict[str, Any]
) -> Optional[str]:
    """
    Find a cover image matching the audio file name or generic names.

    Parameters
    ----------
    audio_path : str
        Path to the audio file.
    cover_config : dict
        Cover art configuration.

    Returns
    -------
    str or None
        Path to the cover image, or None if not found.
    """
    if not cover_config.get("enabled", True):
        return None
    try:
        audio_dir = os.path.dirname(audio_path)
        base_name = os.path.splitext(os.path.basename(audio_path))[0]
        formats = cover_config.get(
            "supported_formats", [".jpg", ".jpeg", ".png", ".bmp", ".webp"]
        )
        for img_ext in formats:
            cover_path = os.path.join(audio_dir, base_name + img_ext)
            if os.path.exists(cover_path):
                logger.info(f"Found cover image: {cover_path}")
                return cover_path
        for name in ["cover", "folder", "front", "album"]:
            for img_ext in formats:
                cover_path = os.path.join(audio_dir, name + img_ext)
                if os.path.exists(cover_path):
                    logger.info(f"Found generic cover image: {cover_path}")
                    return cover_path
        logger.info("No cover image found")
        return None
    except Exception as e:
        logger.warning(f"Error finding cover image: {e}")
        return None


def has_existing_cover(audio_path: str) -> bool:
    """Check if an audio file already has cover art."""
    try:
        if audio_path.lower().endswith(".flac"):
            audio = FLAC(audio_path)
            return len(audio.pictures) > 0
        elif audio_path.lower().endswith(".mp3"):
            audio = MutagenFile(audio_path)
            if audio.tags and isinstance(audio.tags, ID3):
                return any(frame for frame in audio.tags if frame.FrameID == "APIC")
        return False
    except Exception as e:
        logger.warning(f"Error checking existing cover: {e}")
        return False


def set_audio_cover(
    audio_path: str, cover_path: str, cover_config: Dict[str, Any]
) -> bool:
    """Set cover art for an audio file (dispatches by format)."""
    try:
        if has_existing_cover(audio_path) and not cover_config.get(
            "replace_existing", False
        ):
            logger.info("File already has cover art and replace is disabled, skipping")
            return True
        logger.info(f"Setting cover art: {cover_path} -> {audio_path}")
        if audio_path.lower().endswith(".flac"):
            return set_flac_cover(audio_path, cover_path)
        elif audio_path.lower().endswith(".mp3"):
            return set_mp3_cover(audio_path, cover_path)
        logger.warning(f"Cover art not supported for: {audio_path}")
        return False
    except Exception as e:
        logger.error(f"Error setting cover art: {e}")
        return False


def set_flac_cover(flac_path: str, cover_path: str) -> bool:
    """Set cover art for a FLAC file."""
    try:
        audio = FLAC(flac_path)
        audio.clear_pictures()
        picture = Picture()
        picture.type = 3
        picture.desc = "Cover"
        picture.mime = "image/jpeg"
        with open(cover_path, "rb") as f:
            picture.data = f.read()
        try:
            from PIL import Image

            with Image.open(cover_path) as img:
                picture.width, picture.height = img.size
        except ImportError:
            logger.warning("PIL not installed, cannot get image dimensions")
        audio.add_picture(picture)
        audio.save()
        logger.info("FLAC cover art set successfully")
        return True
    except Exception as e:
        logger.error(f"FLAC cover art setting failed: {e}")
        return False


def set_mp3_cover(mp3_path: str, cover_path: str) -> bool:
    """Set cover art (APIC) for an MP3 file."""
    try:
        audio = MutagenFile(mp3_path)
        if audio.tags is None:
            audio.add_tags()
        with open(cover_path, "rb") as f:
            cover_data = f.read()
        audio.tags.add(
            APIC(
                encoding=3,
                mime="image/jpeg",
                type=3,
                desc="Cover",
                data=cover_data,
            )
        )
        audio.save()
        logger.info("MP3 cover art set successfully")
        return True
    except Exception as e:
        logger.error(f"MP3 cover art setting failed: {e}")
        return False


# ============================================================================
# Instrumental Tag Embedding
# ============================================================================


def embed_instrumental_tags(audio_path: str) -> None:
    """Embed special instrumental tags to prevent re-processing."""
    try:
        audio = MutagenFile(audio_path)
        if audio is None:
            return
        instrumental_text = "纯音乐 (Instrumental)"
        if audio.tags and isinstance(audio.tags, ID3):
            uslt = USLT(
                encoding=Encoding.UTF8,
                lang="eng",
                desc="Instrumental Track",
                text=instrumental_text,
            )
            sylt = SYLT(
                encoding=Encoding.UTF8,
                format=2,
                type=1,
                desc="Instrumental Track",
                lang="eng",
                text=[(instrumental_text, 0)],
            )
            audio.tags.delall("USLT")
            audio.tags.delall("SYLT")
            audio.tags.add(uslt)
            audio.tags.add(sylt)
            audio.save()
        elif isinstance(audio, FLAC) and audio.tags:
            audio["LYRICS"] = instrumental_text
            audio["SYNCED_LYRICS"] = f"[00:00.000]{instrumental_text}"
            audio.save()
        logger.info(f"Instrumental tags embedded: {audio_path}")
    except Exception as e:
        logger.warning(f"Error embedding instrumental tags: {e}")


# ============================================================================
# Mode 1/3/4: Video/Audio Utilities
# ============================================================================


def mp4_to_mp3(work_dir: str, filename: str) -> None:
    """Convert MP4 video to MP3 audio via ffmpeg (mode 1)."""
    command = f'ffmpeg -i "{filename}.mp4" -vn -c:a libmp3lame "{filename}.mp3"'
    proc = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=work_dir
    )
    stdout, stderr = proc.communicate()
    logger.info(f"Return code: {proc.returncode}")
    if stderr:
        logger.info(f"Error: {stderr.decode('utf-8')}")


def verify_file(work_dir: str, filename: str, fmt: str) -> None:
    """Verify audio file integrity via ffmpeg (mode 3)."""
    command = f"ffmpeg -v error -i {filename}.{fmt} -f null - /d && ffmpeg -v error -crc -err_detect explode -i {filename}.{fmt} -f null -"
    proc = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=work_dir
    )
    stdout, stderr = proc.communicate()
    logger.info(f"Return code: {proc.returncode}")
    if stderr:
        logger.info(f"Error: {stderr.decode('utf-8')}")


def add_sound_and_view(work_dir: str, filename: str) -> None:
    """Merge MP3 audio with MP4 video (mode 4)."""
    command = f"ffmpeg -i {filename}.mp3 -i {filename}.mp4 -c:v copy -c:a copy {filename}（1）.mp4"
    proc = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=work_dir
    )
    stdout, stderr = proc.communicate()
    logger.info(f"Return code: {proc.returncode}")
    if stderr:
        logger.info(f"Error: {stderr.decode('utf-8')}")


# ============================================================================
# Mode 5: Directory Comparison / Non-ASCII Diagnostics
# ============================================================================


def analyze_filename(filename: str) -> List[Dict[str, str]]:
    """Analyze non-ASCII character issues in a filename."""
    issues = []
    for char in filename:
        if ord(char) > 127:
            issues.append(
                {
                    "char": char,
                    "hex": hex(ord(char)),
                    "name": unicodedata.name(char, "UNKNOWN CHARACTER"),
                    "category": unicodedata.category(char),
                }
            )
    return issues


def compare_directories(
    dir1: str, dir2: str
) -> Tuple[List[Dict[str, Any]], int]:
    """Compare filenames between two directories (case-insensitive) and analyze missing files."""
    files_dir1 = [f for f in os.listdir(dir1) if os.path.isfile(os.path.join(dir1, f))]
    files_dir2 = [f for f in os.listdir(dir2) if os.path.isfile(os.path.join(dir2, f))]
    lower_map1 = {f.lower(): f for f in files_dir1}
    lower_map2 = {f.lower(): f for f in files_dir2}
    missing_lower = set(lower_map1.keys()) - set(lower_map2.keys())
    missing_files = [lower_map1[f] for f in missing_lower]

    detailed_missing = []
    for filename in missing_files:
        issues = analyze_filename(filename)
        detailed_missing.append(
            {
                "filename": filename,
                "issues": issues,
                "exists_in_dir2": any(
                    filename.lower() == name.lower() for name in files_dir2
                ),
            }
        )
    return detailed_missing, len(missing_files)


def compare_directories_and_analyze(dir1: str, dir2: str) -> None:
    """Compare two directories and print non-ASCII character diagnostic report (mode 5)."""
    missing_files, count = compare_directories(dir1, dir2)
    print(f"Missing file count: {count}")
    if count > 0:
        print("=" * 50)
        print("Detailed Analysis Report:")
        print("=" * 50)
        for file_info in missing_files:
            filename = file_info["filename"]
            issues = file_info["issues"]
            exists_variant = file_info["exists_in_dir2"]
            status = "Possible case variant exists" if exists_variant else "Completely missing"
            print(f"\nFilename: {filename} {status}")
            if issues:
                print(f"  - Contains {len(issues)} non-ASCII character(s):")
                for issue in issues:
                    print(f"    - Char: '{issue['char']}'")
                    print(f"      Hex: {issue['hex']}")
                    print(f"      Unicode name: {issue['name']}")
                    print(f"      Category: {issue['category']}")
                    if issue["category"] in ["So", "Sm", "Sc"]:
                        print("      -> Possible issue: special symbol may cause filesystem compatibility problems")
                    elif issue["category"] in ["Mn", "Mc", "Me"]:
                        print("      -> Possible issue: combining character may cause display or sorting problems")
                    elif issue["category"] == "Zs":
                        print("      -> Possible issue: non-standard whitespace may cause parsing problems")
            else:
                print("  - Filename contains only ASCII characters")
            if exists_variant:
                actual_names = [
                    name
                    for name in os.listdir(dir2)
                    if name.lower() == filename.lower()
                ]
                print(f"  - Case variants exist in directory: {', '.join(actual_names)}")
            src_path = os.path.join(dir1, filename)
            if os.path.exists(src_path):
                is_hidden = bool(os.stat(src_path).st_file_attributes & 2)
                if is_hidden:
                    print("  - File is marked as hidden in source directory")
            print("-" * 50)

    print("\n" + "=" * 50)
    print("System encoding info:")
    print(f"Filesystem encoding: {sys.getfilesystemencoding()}")
    print(f"System default encoding: {sys.getdefaultencoding()}")
    print(f"Locale: {locale.getlocale()}")
    print("=" * 50)


# ============================================================================
# Mode 6: Music File Integrity Check
# ============================================================================


def check_music_files_comprehensive(directory: str) -> None:
    """Check embedded images and metadata completeness of music files (mode 6)."""
    print("=== Comprehensive Music File Integrity Check ===")
    audio_extensions = (".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wma", ".wav")
    files_without_images = []
    files_without_metadata = []

    for root, dirs, files in os.walk(directory):
        for file in files:
            if not file.lower().endswith(audio_extensions):
                continue
            file_path = os.path.join(root, file)
            try:
                audio = MutagenFile(file_path)
                if audio is None:
                    continue

                has_image = False
                if isinstance(audio, MP4):
                    if "covr" in audio.tags:
                        has_image = True
                elif hasattr(audio, "tags") and audio.tags:
                    if isinstance(audio.tags, ID3):
                        if audio.tags.getall("APIC"):
                            has_image = True
                    elif isinstance(audio, FLAC):
                        if audio.pictures:
                            has_image = True
                if not has_image:
                    files_without_images.append(file_path)

                has_title = has_artist = has_album = False
                if hasattr(audio, "tags") and audio.tags:
                    if isinstance(audio.tags, ID3):
                        has_title = bool(audio.tags.get("TIT2"))
                        has_artist = bool(audio.tags.get("TPE1"))
                        has_album = bool(audio.tags.get("TALB"))
                    elif isinstance(audio, FLAC):
                        has_title = bool(audio.get("title"))
                        has_artist = bool(audio.get("artist"))
                        has_album = bool(audio.get("album"))
                    elif isinstance(audio, MP4):
                        has_title = bool(audio.get("\xa9nam"))
                        has_artist = bool(audio.get("\xa9ART"))
                        has_album = bool(audio.get("\xa9alb"))
                if not (has_title and has_artist and has_album):
                    missing_items = []
                    if not has_title:
                        missing_items.append("Title")
                    if not has_artist:
                        missing_items.append("Artist")
                    if not has_album:
                        missing_items.append("Album")
                    files_without_metadata.append(
                        {"path": file_path, "missing": missing_items}
                    )
            except Exception as e:
                print(f"Error processing {file_path}: {e}")

    print("=== Embedded Image Check Results ===")
    if files_without_images:
        print(f"Found {len(files_without_images)} file(s) without embedded images:")
        for file_path in files_without_images:
            print(f"  - {file_path}")
    else:
        print("All music files contain embedded images")

    print("\n=== Metadata Check Results ===")
    if files_without_metadata:
        print(f"Found {len(files_without_metadata)} file(s) missing metadata:")
        for item in files_without_metadata:
            missing_str = ", ".join(item["missing"])
            print(f"  - {item['path']} (missing: {missing_str})")
    else:
        print("All music files have complete metadata (Title, Artist, Album)")


# ============================================================================
# Romaji Processing (mode 7)
# ============================================================================


def read_flac_lyrics(file_path: str) -> List[str]:
    """Read FLAC lyrics field and split by lines."""
    audio_file_lyrics = FLAC(file_path)["lyrics"]
    list_audio_file_lyrics = audio_file_lyrics[0].split("\n")
    return list_audio_file_lyrics


def chek_japanese(text: str) -> Optional[re.Match]:
    """Check if text contains Japanese characters (hiragana/katakana)."""
    text_check = re.compile(r"[\u3040-\u309f\u30a0-\u30ff]")
    return text_check.search(text)


def add_romaji(list_audio_file_lyrics: list) -> list:
    """Add romaji to Japanese lyrics; skips if already contains romaji."""
    pattern = r"\[\d{1,2}:\d{2}(?:\.\d{2,3})?\]|\[\d{1,2}:\d{2}:\d{2,3}\]"
    romaji = list_audio_file_lyrics[:]

    has_romaji = False
    has_romaji_counter = 0
    for line in list_audio_file_lyrics:
        if line and not chek_japanese(line):
            latin_pattern = re.compile(r"[a-zA-Z\s]+")
            if latin_pattern.search(line) and not re.search(r"[\u4e00-\u9fff]", line):
                has_romaji_counter += 1
                if has_romaji_counter > 12:
                    has_romaji = True
                    break
                continue

    if has_romaji:
        logger.info("Lyrics already contain romaji, skipping")
        return list_audio_file_lyrics

    romaji.append("\n【Romaji:】")
    for i in list_audio_file_lyrics:
        match = re.search(pattern, i)
        if match:
            timestamp = match.group(0)
        else:
            continue
        if chek_japanese(i):
            lyric_part = i[len(timestamp):].strip()
            if lyric_part:
                romaji_line = f"{timestamp} {get_romaji(lyric_part)}"
                romaji.append(romaji_line)
    return romaji


def get_romaji(text: str) -> str:
    """Convert Japanese text to romaji (pykakasi hepburn)."""
    kks = kakasi()
    result = kks.convert(text)
    romaji_text = " ".join([item["hepburn"] for item in result])
    return romaji_text


def generate_lrc_from_audio_romaji(audio_path: str) -> Optional[str]:
    """Extract lyrics from processed audio and generate LRC content (trilingual: JP + romaji + ZH)."""
    try:
        audio = MutagenFile(audio_path)
        if audio is None:
            return None

        lrc_lines = []
        if audio.tags and isinstance(audio.tags, ID3):
            sylt_frames = audio.tags.getall("SYLT")
            if sylt_frames and sylt_frames[0].text:
                for text, timestamp in sylt_frames[0].text:
                    lrc_lines.append(f"{_format_timestamp(timestamp)}{text}")
            elif audio.tags.getall("USLT"):
                uslt_content = audio.tags.getall("USLT")[0].text
                if uslt_content:
                    lrc_lines = uslt_content.strip().split("\n")
        elif isinstance(audio, FLAC) and audio.tags:
            for field in ["SYNCED_LYRICS", "SYNCED LYRICS", "slyrics", "SLYRICS"]:
                if field in audio.tags:
                    lrc_lines = audio.tags[field]
                    break
            else:
                for field in ["LYRICS", "lyrics"]:
                    if field in audio.tags and audio.tags[field]:
                        lrc_lines = audio.tags[field][0].strip().split("\n")
                        break

        if not lrc_lines:
            return None
        return "\n".join(lrc_lines)
    except Exception as e:
        logger.warning(f"Error generating LRC content: {e}")
        return None


def save_lrc_file_romaji(
    audio_path: str, output_base_dir: Optional[str] = None
) -> Optional[str]:
    """Save trilingual LRC to lrc_romaji subdirectory (mode 7)."""
    try:
        if output_base_dir is None:
            output_base_dir = os.path.dirname(audio_path)
        lrc_output_dir = os.path.join(output_base_dir, "lrc_romaji")
        os.makedirs(lrc_output_dir, exist_ok=True)
        base_name = os.path.basename(audio_path)
        name, _ = os.path.splitext(base_name)
        lrc_content = generate_lrc_from_audio_romaji(audio_path)
        if not lrc_content:
            logger.warning(f"Cannot generate LRC content: {audio_path}")
            return None
        lrc_output_path = os.path.join(lrc_output_dir, f"{name}.lrc")
        with open(lrc_output_path, "w", encoding="utf-8") as f:
            f.write(lrc_content)
        logger.info(f"LRC file saved to: {lrc_output_path}")
        return lrc_output_path
    except Exception as e:
        logger.error(f"Error saving LRC file: {e}")
        logger.error(traceback.format_exc())
        return None


# ============================================================================
# Mode 7: Romaji Batch Processing
# ============================================================================


def process_audio_file_with_romaji(
    audio_path: str, output_dir: str
) -> Tuple[bool, Optional[str], Optional[str]]:
    """Add romaji to bilingual lyrics for a single audio file (mode 7 core)."""
    try:
        logger.info(f"Processing audio file: {audio_path}")
        audio = MutagenFile(audio_path)
        if audio is None:
            return False, None, "Cannot recognize audio file"

        has_lyrics, lyrics_type, lyrics_info = check_embedded_lyrics(audio_path)
        if not has_lyrics:
            detailed_reason = diagnose_no_lyrics_reason(audio_path)
            error_msg = f"No embedded lyrics\nDetailed diagnosis:\n{detailed_reason}"
            logger.info(f"File has no embedded lyrics: {audio_path}")
            logger.info(f"Detailed diagnosis:\n{detailed_reason}")
            return False, None, error_msg

        os.makedirs(output_dir, exist_ok=True)
        base_name = os.path.basename(audio_path)
        name, ext = os.path.splitext(base_name)
        output_path = os.path.join(output_dir, f"{name}{ext}")
        shutil.copy2(audio_path, output_path)

        if ext.lower() == ".mp3":
            success, error = process_mp3_lyrics_with_romaji(output_path, lyrics_info)
        elif ext.lower() == ".flac":
            success, error = process_flac_lyrics_with_romaji(output_path, lyrics_info)
        else:
            logger.warning(f"Unsupported format: {ext}")
            return False, None, f"Unsupported format: {ext}"

        if success:
            logger.info(f"File processed successfully: {output_path}")
            lrc_path = save_lrc_file_romaji(output_path, os.path.dirname(audio_path))
            if lrc_path:
                logger.info(f"LRC lyrics file saved: {lrc_path}")
            return True, output_path, None
        else:
            logger.error(f"Processing failed: {error}")
            if os.path.exists(output_path):
                os.remove(output_path)
            return False, None, error
    except Exception as e:
        logger.error(f"Error processing file: {e}")
        logger.error(traceback.format_exc())
        return False, None, str(e)


def process_mp3_lyrics_with_romaji(
    audio_path: str, lyrics_info: Dict[str, Any]
) -> Tuple[bool, Optional[str]]:
    """Process MP3 lyric tags to add romaji."""
    try:
        audio = MutagenFile(audio_path)
        if audio is None or not audio.tags:
            return False, "Cannot read MP3 tags"

        processed_tags = []

        uslt_frames = audio.tags.getall("USLT")
        for frame in uslt_frames:
            lyrics_lines = frame.text.split("\n")
            processed_lyrics = add_romaji(lyrics_lines)
            frame.text = "\n".join(processed_lyrics)
            processed_tags.append("USLT")

        sylt_frames = audio.tags.getall("SYLT")
        for frame in sylt_frames:
            lyrics_lines = []
            for text, timestamp in frame.text:
                lyrics_lines.append(f"{_format_timestamp(timestamp)}{text}")
            processed_lyrics = add_romaji(lyrics_lines)
            new_sylt_data = []
            for line in processed_lyrics:
                m = re.match(r"\[(\d{1,2}):(\d{2})\.(\d{3})\](.*)", line)
                if m:
                    mins, secs, ms, text = m.groups()
                    timestamp = (int(mins) * 60 + int(secs)) * 1000 + int(ms)
                    new_sylt_data.append((text.strip(), timestamp))
            audio.tags.delall("SYLT")
            sylt_frame = SYLT(
                encoding=Encoding.UTF8,
                lang=frame.lang,
                format=1,
                type=1,
                text=new_sylt_data,
            )
            audio.tags.add(sylt_frame)
            processed_tags.append("SYLT")

        for tag in ["TXXX:LYRICS", "COMM:LYRICS", "WXXX:LYRICS"]:
            if tag in audio.tags:
                lyrics_content = (
                    audio.tags[tag].text[0]
                    if hasattr(audio.tags[tag], "text")
                    else str(audio.tags[tag])
                )
                processed_lyrics = add_romaji(lyrics_content.split("\n"))
                audio.tags[tag] = "\n".join(processed_lyrics)
                processed_tags.append(tag)

        if not processed_tags:
            return False, "No lyric tags found"

        audio.save()
        logger.info(
            f"MP3 processing complete, {len(processed_tags)} tag(s) processed: {', '.join(processed_tags)}"
        )
        return True, None
    except Exception as e:
        logger.error(f"Error processing MP3 lyrics: {e}")
        logger.error(traceback.format_exc())
        return False, str(e)


def process_flac_lyrics_with_romaji(
    audio_path: str, lyrics_info: Dict[str, Any]
) -> Tuple[bool, Optional[str]]:
    """Process FLAC lyric tags to add romaji."""
    try:
        audio = FLAC(audio_path)
        if audio is None:
            return False, "Cannot read FLAC file"

        processed_tags = []
        synced_fields = ["SYNCED LYRICS", "SYNCED_LYRICS", "slyrics", "SLYRICS"]
        for field in synced_fields:
            if field in audio.tags:
                logger.info(f"Processing {field} lyrics...")
                lyrics_lines = audio.tags[field]
                text_lines = []
                for line in lyrics_lines:
                    parsed = _parse_timestamp_line(line)
                    if parsed:
                        ts, text = parsed
                        text_lines.append(f"{_format_timestamp(ts)}{text.strip()}")
                    else:
                        text_lines.append(line)
                processed_lyrics = add_romaji(text_lines)
                audio.tags[field] = processed_lyrics
                processed_tags.append(field)

        unsynced_fields = ["LYRICS", "lyrics", "UNSYNCED LYRICS", "UNSYNCED_LYRICS"]
        for field in unsynced_fields:
            if field in audio.tags:
                logger.info(f"Processing {field} lyrics...")
                lyrics_content = audio.tags[field][0] if audio.tags[field] else ""
                processed_lyrics = add_romaji(lyrics_content.split("\n"))
                audio.tags[field] = ["\n".join(processed_lyrics)]
                processed_tags.append(field)

        if not processed_tags:
            return False, "No lyric tags found"

        audio.save()
        logger.info(
            f"FLAC processing complete, {len(processed_tags)} tag(s) processed: {', '.join(processed_tags)}"
        )
        return True, None
    except Exception as e:
        logger.error(f"Error processing FLAC lyrics: {e}")
        logger.error(traceback.format_exc())
        return False, str(e)


def process_files_and_folders_romaji(
    input_paths: List[str],
) -> Optional[List[Dict[str, Any]]]:
    """Batch-process files/folders to add romaji to Japanese lyrics (mode 7)."""
    audio_files: List[str] = []

    for path in input_paths:
        if os.path.isfile(path):
            if path.lower().endswith((".mp3", ".flac")):
                audio_files.append(path)
            else:
                logger.warning(f"Skipping non-audio file: {path}")
        elif os.path.isdir(path):
            for root, dirs, files in os.walk(path):
                if "audio_with_romaji" in dirs:
                    dirs.remove("audio_with_romaji")
                dirs[:] = [d for d in dirs if "audio_with_romaji" not in d]
                for file in files:
                    if file.lower().endswith((".mp3", ".flac")):
                        audio_files.append(os.path.join(root, file))
        else:
            logger.warning(f"Path does not exist: {path}")

    if not audio_files:
        logger.error("No audio files found to process")
        return None

    logger.info(f"Found {len(audio_files)} audio file(s) to process")
    results = []
    for i, audio_file in enumerate(audio_files, 1):
        logger.info(f"{'='*60}")
        logger.info(f"Processing file {i}/{len(audio_files)}: {audio_file}")
        output_dir = os.path.join(os.path.dirname(audio_file), "audio_with_romaji")
        success, output_path, error = process_audio_file_with_romaji(
            audio_file, output_dir
        )
        results.append(
            {
                "file": audio_file,
                "output_path": output_path,
                "success": success,
                "error": error,
            }
        )
        if success:
            logger.info(f"File processing complete: {output_path}")
        else:
            logger.error(f"File processing failed: {error}")

    successful = sum(1 for r in results if r["success"])
    failed = len(results) - successful
    logger.info("=" * 60)
    logger.info("Processing summary:")
    logger.info(f"  Total files: {len(results)}")
    logger.info(f"  Successful:  {successful}")
    logger.info(f"  Failed:      {failed}")
    logger.info("=" * 60)
    if failed > 0:
        logger.info("=" * 60)
        logger.info("Failed file details:")
        logger.info("=" * 60)
        for result in results:
            if not result["success"]:
                logger.info(f"\nFile: {result['file']}")
                logger.info(f"Error:\n{result['error']}")
                logger.info("-" * 60)
    return results


# ============================================================================
# Mode 8: Lyrics Diagnosis / Viewing
# ============================================================================


def diagnose_no_lyrics_reason(audio_path: str) -> str:
    """Diagnose why a file has no embedded lyrics."""
    try:
        audio = MutagenFile(audio_path)
        if audio is None:
            return "Cannot recognize audio file format"

        diagnosis = []
        file_ext = os.path.splitext(audio_path)[1].lower()
        file_size = os.path.getsize(audio_path)
        diagnosis.append(
            f"File format: {file_ext}, File size: {file_size / 1024 / 1024:.2f} MB"
        )

        if hasattr(audio, "info"):
            info = audio.info
            diagnosis.append("\n=== Audio File Properties ===")
            if hasattr(info, "length"):
                minutes = int(info.length // 60)
                seconds = int(info.length % 60)
                diagnosis.append(
                    f"  Duration: {minutes}:{seconds:02d} ({info.length:.2f}s)"
                )
            if hasattr(info, "bitrate"):
                diagnosis.append(f"  Bitrate: {info.bitrate / 1000:.0f} kbps")
            if hasattr(info, "sample_rate"):
                diagnosis.append(f"  Sample rate: {info.sample_rate} Hz")
            if hasattr(info, "channels"):
                diagnosis.append(f"  Channels: {info.channels}")
            if hasattr(info, "bits_per_sample"):
                diagnosis.append(f"  Bit depth: {info.bits_per_sample} bit")
            diagnosis.append(f"  Actual file type: {type(audio).__name__}")

        if audio.tags is None:
            diagnosis.append("File has no metadata tags")
        else:
            if isinstance(audio.tags, ID3):
                all_frames = {}
                for frame in audio.tags:
                    frame_id = frame.FrameID
                    all_frames.setdefault(frame_id, [])
                    frame_desc = getattr(frame, "desc", "")
                    frame_text = getattr(frame, "text", "")
                    if frame_text:
                        preview = str(frame_text)[:50]
                        all_frames[frame_id].append(
                            f"desc='{frame_desc}', text='{preview}'"
                        )
                    else:
                        all_frames[frame_id].append(f"desc='{frame_desc}'")
                diagnosis.append(
                    f"\n=== All ID3 Tag Frames ({len(all_frames)} types) ==="
                )
                for frame_id, infos in sorted(all_frames.items()):
                    diagnosis.append(
                        f"  [{frame_id}] ({len(infos)}): {'; '.join(infos[:2])}"
                    )

                sylt_frames = audio.tags.getall("SYLT")
                uslt_frames = audio.tags.getall("USLT")
                if sylt_frames:
                    diagnosis.append(
                        f"\nFound SYLT sync lyrics tag(s): {len(sylt_frames)}"
                    )
                    if sylt_frames[0].text:
                        diagnosis.append(f"   SYLT line count: {len(sylt_frames[0].text)}")
                    else:
                        diagnosis.append("   SYLT tag exists but content is empty")
                else:
                    diagnosis.append("\nNo SYLT sync lyrics tag found")
                if uslt_frames:
                    diagnosis.append(
                        f"Found USLT unsync lyrics tag(s): {len(uslt_frames)}"
                    )
                    if hasattr(uslt_frames[0], "text") and uslt_frames[0].text:
                        content = uslt_frames[0].text
                        diagnosis.append(f"   USLT content length: {len(content)} chars")
                        diagnosis.append(
                            f"   USLT content preview: {content[:100].replace(chr(10), chr(92) + 'n')}..."
                        )
                    else:
                        diagnosis.append("   USLT tag exists but content is empty")
                else:
                    diagnosis.append("No USLT unsync lyrics tag found")

                txxx_frames = audio.tags.getall("TXXX")
                if txxx_frames:
                    diagnosis.append(
                        f"\n=== TXXX Custom Tags ({len(txxx_frames)}) ==="
                    )
                    for txxx in txxx_frames[:10]:
                        desc = getattr(txxx, "desc", "N/A")
                        text = getattr(txxx, "text", "")
                        preview = str(text)[:50]
                        diagnosis.append(f"  TXXX[{desc}]: {preview}")
                    lyric_related = [
                        f
                        for f in txxx_frames
                        if hasattr(f, "desc")
                        and ("lyric" in f.desc.lower() or "歌词" in f.desc)
                    ]
                    if lyric_related:
                        diagnosis.append(
                            f"  Lyric-related TXXX tags: {[f.desc for f in lyric_related]}"
                        )
            elif isinstance(audio, FLAC):
                if audio.tags:
                    all_keys = list(audio.tags.keys())
                    diagnosis.append(
                        f"\n=== All Vorbis Tags ({len(all_keys)}) ==="
                    )
                    for key in sorted(all_keys):
                        value = audio.tags[key]
                        if isinstance(value, list):
                            value_str = "; ".join([str(v)[:50] for v in value[:3]])
                        else:
                            value_str = str(value)[:50]
                        diagnosis.append(f"  [{key}]: {value_str}")
                    lyric_fields = [
                        "LYRICS", "lyrics", "LYRIC", "lyric",
                        "SYNCED LYRICS", "SYNCED_LYRICS", "slyrics", "SLYRICS",
                    ]
                    found_lyric_fields = [f for f in lyric_fields if f in audio.tags]
                    if found_lyric_fields:
                        diagnosis.append(
                            f"\nLyric-related fields found: {', '.join(found_lyric_fields)}"
                        )
                        for field in found_lyric_fields:
                            content = audio.tags[field]
                            if isinstance(content, list):
                                diagnosis.append(f"   {field}: {len(content)} lines")
                            else:
                                diagnosis.append(
                                    f"   {field}: {len(str(content))} chars"
                                )
                    else:
                        diagnosis.append("\nNo lyric-related fields found")
                    potential_lyric_fields = [
                        k
                        for k in all_keys
                        if any(
                            keyword in k.lower()
                            for keyword in [
                                "lyric", "text", "comment", "unsync", "sync", "lrc",
                            ]
                        )
                    ]
                    if potential_lyric_fields:
                        diagnosis.append(
                            f"\nFields possibly containing lyrics: {potential_lyric_fields}"
                        )
                else:
                    diagnosis.append("FLAC file has no Vorbis tags")
            else:
                diagnosis.append(f"Unknown audio format type: {type(audio)}")

        audio_dir = os.path.dirname(audio_path)
        audio_name = os.path.splitext(os.path.basename(audio_path))[0]
        external_lyrics = []
        for ext in [".lrc", ".txt", ".srt", ".ass", ".ssa"]:
            exact_path = os.path.join(audio_dir, audio_name + ext)
            if os.path.exists(exact_path):
                external_lyrics.append(exact_path)
        if external_lyrics:
            diagnosis.append(f"\nExternal lyric files found: {', '.join(external_lyrics)}")
            diagnosis.append(
                "   Hint: external lyric files won't be processed; embed them first"
            )
        else:
            diagnosis.append("\nNo external lyric files found (.lrc, .txt, .srt, etc.)")

        title = None
        artist = None
        if audio.tags:
            if isinstance(audio.tags, ID3):
                title = audio.tags.get("TIT2")
                artist = audio.tags.get("TPE1")
            elif isinstance(audio, FLAC):
                title = (
                    audio.tags.get("title", [None])[0]
                    if "title" in audio.tags
                    else None
                )
                artist = (
                    audio.tags.get("artist", [None])[0]
                    if "artist" in audio.tags
                    else None
                )
        if title:
            title_text = str(title)
            if (
                "instrumental" in title_text.lower()
                or "纯音乐" in title_text
                or "伴奏" in title_text
            ):
                diagnosis.append("\nFilename or title suggests it might be instrumental")

        return "\n".join(diagnosis)
    except Exception as e:
        return f"Diagnosis error: {e}"


def extract_lyrics(file_path: str) -> None:
    """View embedded lyrics (mode 8 entry)."""
    if not os.path.isfile(file_path):
        print(f"Error: File not found - {file_path}")
        return
    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext == ".mp3":
            extract_mp3_lyrics(file_path)
        elif ext == ".flac":
            extract_flac_lyrics(file_path)
        else:
            print(f"Unsupported file format: {ext} (only .mp3 and .flac supported)")
    except Exception as e:
        print(f"Error reading lyrics: {e}")


def extract_mp3_lyrics(file_path: str) -> None:
    """View MP3 embedded lyrics (USLT / SYLT)."""
    audio = MP3(file_path, ID3=ID3)
    if audio.tags is None:
        print("This MP3 file has no ID3 tags.")
        return

    lyrics_found = False
    for tag in audio.tags.values():
        if isinstance(tag, USLT):
            print("Found embedded unsynchronized lyrics (USLT):")
            print(str(tag.text))
            lyrics_found = True
    for tag in audio.tags.values():
        if isinstance(tag, SYLT):
            print("Found embedded synchronized lyrics (SYLT):")
            try:
                for text, timestamp in tag.text:
                    if isinstance(timestamp, str):
                        try:
                            timestamp = int(float(timestamp) * 1000)
                        except ValueError:
                            timestamp = 0
                    elif not isinstance(timestamp, int):
                        timestamp = 0
                    total_seconds = timestamp // 1000
                    millis = timestamp % 1000
                    minutes = total_seconds // 60
                    seconds = total_seconds % 60
                    centis = millis // 10
                    print(f"[{minutes:02d}:{seconds:02d}.{centis:02d}] {text}")
            except Exception as parse_err:
                print(f"  Error parsing SYLT lyrics: {parse_err}")
                print(f"  Raw SYLT content: {tag.text}")
            lyrics_found = True

    if not lyrics_found:
        print("No embedded lyrics found (USLT or SYLT frames).")


def extract_flac_lyrics(file_path: str) -> None:
    """View FLAC embedded lyrics and all fields."""
    audio = FLAC(file_path)
    if not audio:
        print("Cannot read FLAC file or file is empty.")
        return

    print("All FLAC fields and content:")
    for key in sorted(audio.keys()):
        values = audio[key]
        if len(values) == 1:
            print(f"  '{key}': {repr(values[0])}")
        else:
            print(f"  '{key}': [")
            for v in values:
                print(f"    {repr(v)}")
            print("  ]")
    print()

    lyric_fields = [
        "LYRICS", "UNSYNCEDLYRICS", "SYNCHRONIZEDLYRICS",
        "TEXT", "COMMENT", "DESCRIPTION",
    ]
    lyrics_found = False
    for field in lyric_fields:
        if field in audio:
            values = audio[field]
            if values:
                print(f"Found FLAC lyrics field '{field}':")
                for line in values:
                    print(line)
                lyrics_found = True
            else:
                print(f"FLAC field '{field}' exists but content is empty.")

    if not lyrics_found:
        print(
            "No valid lyrics content found in FLAC file "
            "(checked: LYRICS, UNSYNCEDLYRICS, SYNCHRONIZEDLYRICS, TEXT, COMMENT, DESCRIPTION)."
        )


# ============================================================================
# Mode 9: MP3/FLAC Fuzzy Matching & Migration
# ============================================================================


def normalize_for_comparison(name: str) -> str:
    """Normalize filename for comparison (lowercase, underscores/hyphens -> space)."""
    name = name.lower().strip()
    name = re.sub(r"[_\-]+", " ", name)
    name = " ".join(name.split())
    return name


def extract_flac_title(flac_filename: str) -> str:
    """Extract title from FLAC filename (removes `` - [...]`` suffix)."""
    stem = Path(flac_filename).stem
    match = re.split(r"\s*-\s*\[", stem, maxsplit=1)
    if len(match) >= 2:
        return match[0].strip()
    return stem.strip()


def find_matching_tracks(
    mp3_folder: str, flac_folder: str, similarity_threshold: float = 0.85
) -> List[Tuple[str, str, float]]:
    """Fuzzy-match MP3 and FLAC tracks between two directories."""
    mp3_files = []
    flac_files = []

    for file in os.listdir(mp3_folder):
        if file.lower().endswith(".mp3"):
            norm_name = normalize_for_comparison(Path(file).stem)
            mp3_files.append((norm_name, os.path.join(mp3_folder, file)))
    for file in os.listdir(flac_folder):
        if file.lower().endswith(".flac"):
            title_part = extract_flac_title(file)
            norm_name = normalize_for_comparison(title_part)
            flac_files.append((norm_name, os.path.join(flac_folder, file)))

    matches = []
    used_flac: set = set()
    for mp3_norm, mp3_path in mp3_files:
        best_match = None
        best_ratio = 0.0
        for flac_norm, flac_path in flac_files:
            if flac_path in used_flac:
                continue
            ratio = difflib.SequenceMatcher(None, mp3_norm, flac_norm).ratio()
            if ratio > best_ratio and ratio >= similarity_threshold:
                best_ratio = ratio
                best_match = (flac_norm, flac_path)
        if best_match:
            used_flac.add(best_match[1])
            matches.append((mp3_path, best_match[1], best_ratio))
    return matches


def perform_file_operations(
    matched_pairs: List[Tuple[str, str, float]], target_flac_folder: str
) -> None:
    """Execute file operations: MP3 -> recycle bin, FLAC -> target folder."""
    os.makedirs(target_flac_folder, exist_ok=True)
    success_count = 0
    for mp3_path, flac_path, score in matched_pairs:
        try:
            send2trash(mp3_path)
            print(f"MP3 moved to recycle bin: {os.path.basename(mp3_path)}")
            flac_filename = os.path.basename(flac_path)
            dest_path = os.path.join(target_flac_folder, flac_filename)
            counter = 1
            base, ext = os.path.splitext(dest_path)
            while os.path.exists(dest_path):
                dest_path = f"{base}_{counter}{ext}"
                counter += 1
            os.rename(flac_path, dest_path)
            print(f"FLAC moved to: {dest_path}")
            success_count += 1
        except Exception as e:
            print(
                f"Operation failed ({os.path.basename(mp3_path)} / {os.path.basename(flac_path)}): {e}"
            )
    print(f"\nSuccessfully processed {success_count} file pair(s).")


def mp3_flac_match_and_migrate(
    mp3_folder: str,
    flac_folder: str,
    target_flac_output_folder: str,
    similarity_threshold: float = 0.5,
) -> None:
    """Mode 9 entry: fuzzy-match then confirm migration."""
    matched_pairs = find_matching_tracks(mp3_folder, flac_folder, similarity_threshold)
    print(
        f"Found {len(matched_pairs)} fuzzy-matched music file pair(s) "
        f"(similarity >= {similarity_threshold}):\n"
    )
    for mp3_file, flac_file, score in matched_pairs:
        print(f"MP3 : {mp3_file}")
        print(f"FLAC: {flac_file}")
        print(f"Similarity: {score:.3f}")
        print("-" * 60)

    if not matched_pairs:
        print("No matches found, nothing to do.")
        sys.exit(0)

    print("\nAbout to perform the following operations:")
    print(f"  - Move {len(matched_pairs)} MP3 file(s) to Windows Recycle Bin")
    print(f"  - Move corresponding FLAC file(s) to: {target_flac_output_folder}")
    user_input = input("\nContinue? (enter y/Y to confirm, any other key to cancel): ").strip().lower()
    if user_input == "y":
        print("\nStarting file operations...\n")
        perform_file_operations(matched_pairs, target_flac_output_folder)
    else:
        print("\nOperation cancelled by user.")


# ============================================================================
# main() Entry Point
# ============================================================================


def main() -> None:
    """
    Mode dispatch main entry point.

    All configuration is read from the unified config (loaded via ``load_config()``).
    Command-line arguments can override mode and basic settings.
    """
    parser = argparse.ArgumentParser(
        description="Music File Processing Toolkit -- Lyric Recognition, Translation & Embedding Pipeline"
    )
    parser.add_argument(
        "-c", "--config", type=str, default=None,
        help="Path to YAML config file (default: config.yaml in script directory)"
    )
    parser.add_argument(
        "-m", "--mode", type=int, default=None,
        help="Operation mode (1-9). Overrides config file mode."
    )
    parser.add_argument(
        "--base-dir", type=str, default=None,
        help="Base music directory"
    )
    parser.add_argument(
        "inputs", nargs="*", default=None,
        help="Input files or directories (for modes 2, 7)"
    )
    args = parser.parse_args()

    cfg = load_config(args.config)

    if args.mode is not None:
        cfg["mode"] = args.mode
    mode = cfg["mode"]

    paths = cfg["paths"]
    base_dir = paths.get("base_dir") or ""

    if args.base_dir:
        paths["base_dir"] = args.base_dir
        base_dir = args.base_dir

    # Mode settings
    processing = cfg["processing"]
    whisper_model_size = processing.get("whisper_model_size", "medium")
    translation_mode = processing.get("translation_mode", "line_by_line")
    local_model_dir = processing.get("local_model_dir")
    vad_model_path = processing.get("vad_model_path")
    force_reprocess = processing.get("force_reprocess_lyrics", False)
    manual_language = processing.get("manual_language")
    manual_is_instrumental = processing.get("manual_is_instrumental")

    llm_api_config = cfg.get("api", {}).get("llm") if translation_mode == "llm" else None
    cover_config = cfg.get("cover")
    gpu_config = cfg.get("gpu")

    if gpu_config:
        setup_multi_gpu(gpu_config)

    # Determine input paths
    if args.inputs:
        input_paths = list(args.inputs)
    else:
        input_paths = [str(p) for p in paths.get("input_paths", [])]

    # Path helpers
    def _resolve(config_path: Any, env_name: str, fallback: str = "") -> str:
        val = config_path or os.environ.get(env_name, "")
        return str(val) if val else fallback

    work_dir = _resolve(
        paths.get("work_dir"), "MUSIC_WORK_DIR",
        paths.get("download_dir") or str(Path(base_dir) / "Downloads") if base_dir else ""
    )
    work_filename = paths.get("work_filename", "")
    work_audio_format = paths.get("work_audio_format", "mp3")

    compare_dir1 = _resolve(paths.get("compare_dir1"), "", str(Path(base_dir) / "音乐无损版") if base_dir else "")
    compare_dir2 = _resolve(paths.get("compare_dir2"), "", str(Path(base_dir) / "音乐无损版" / "audio_with_lyrics") if base_dir else "")

    check_dir = _resolve(
        paths.get("check_dir"), "MUSIC_CHECK_DIR",
        str(Path(base_dir) / "音乐补充（非无损）") if base_dir else ""
    )

    lyrics_file = paths.get("lyrics_file") or (
        str(Path(base_dir) / "audio_with_romaji" / "梦与星海之间 - ['司南'].flac") if base_dir else ""
    )

    mp3_folder = _resolve(
        paths.get("mp3_folder"), "",
        str(Path(base_dir) / "音乐补充（非无损）") if base_dir else ""
    )
    flac_folder = _resolve(
        paths.get("flac_folder"), "",
        str(Path(base_dir) / "音乐补充（非无损）_HQ") if base_dir else ""
    )
    flac_output_folder = _resolve(
        paths.get("flac_output_folder"), "",
        str(Path(base_dir) / "已匹配的无损音乐") if base_dir else ""
    )
    match_similarity_threshold = paths.get("match_similarity_threshold", 0.5)

    # ======================== Mode Dispatch ========================
    if mode == 1:
        mp4_to_mp3(work_dir, work_filename)
    elif mode == 2:
        process_files_and_folders(
            input_paths=input_paths,
            whisper_model_size=whisper_model_size,
            local_model_dir=local_model_dir,
            translation_mode=translation_mode,
            vad_model_path=vad_model_path,
            llm_api_config=llm_api_config,
            cover_config=cover_config,
            force_reprocess=force_reprocess,
            manual_language=manual_language,
            manual_is_instrumental=manual_is_instrumental,
        )
    elif mode == 3:
        verify_file(work_dir, work_filename, work_audio_format)
    elif mode == 4:
        add_sound_and_view(work_dir, work_filename)
    elif mode == 5:
        compare_directories_and_analyze(dir1=compare_dir1, dir2=compare_dir2)
    elif mode == 6:
        check_music_files_comprehensive(check_dir)
    elif mode == 7:
        process_files_and_folders_romaji(input_paths=input_paths)
    elif mode == 8:
        extract_lyrics(lyrics_file)
    elif mode == 9:
        mp3_flac_match_and_migrate(
            mp3_folder=mp3_folder,
            flac_folder=flac_folder,
            target_flac_output_folder=flac_output_folder,
            similarity_threshold=match_similarity_threshold,
        )
    else:
        print(f"Error: Unknown mode {mode}. Valid modes are 1-9.")
        sys.exit(1)


if __name__ == "__main__":
    main()