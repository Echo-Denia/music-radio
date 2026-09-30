<!-- @format -->

# music-radio - VSCode 音乐播放器

[![VSCode Marketplace](https://img.shields.io/visual-studio-marketplace/v/Echo-Denia.music-radio?label=VSCode%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=Echo-Denia.music-radio)
[![GitHub](https://img.shields.io/github/stars/Echo-Denia/music-radio?style=social&logo=github)](https://github.com/Echo-Denia/music-radio)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一款在 VSCode 中运行的音乐播放器插件，支持实时歌词显示。边写代码边听歌，摸鱼必备 🎧

## 功能特性

- 🎵 **音乐播放** - 支持多种音频格式（MP3, FLAC, WAV, OGG, M4A, AAC, WMA, OPUS, MP4）
- 📝 **实时歌词** - 播放时同步显示音乐文件的内嵌歌词、外挂歌词等，支持显示实时歌词在底边栏便于摸鱼（如果音乐文件有内嵌/外挂实时歌词的话）
- 🏷️ **元数据编辑** - 支持查看和编辑音频文件的元数据（标题、艺术家、专辑、流派、年份、音轨号、评论、歌词），可保存到原文件或另存为新文件
- 📂 **音乐库管理** - 添加本地音乐文件夹，自动扫描音乐文件
- 🔀 **播放模式** - 支持随机播放、列表循环、单曲循环
- 🔍 **音乐搜索** - 快速搜索音乐库中的歌曲
- 🎛️ **播放控制** - 播放/暂停、上一首/下一首、音量调节，支持在底边栏控制播放情况，便于摸鱼
- 📋 **播放列表** - 支持播放下一首、移除歌曲、清空列表
- 🎛️ **Tuner 面板** - 模块化音频效果器系统，支持可插拔效果器链：
  - **Equalizer** - 10 段参数均衡器，11 种预设（Flat/Rock/Pop/Jazz/Classical/Hip-Hop/Vocal/Bass Boost/Treble Boost/Electronic/Custom）
  - **Tone** - Bass/Treble 音调控制
  - **Compressor** - 动态压缩器（Threshold/Knee/Ratio/Attack/Release）
  - **Limiter** - 限幅器（Threshold/Release），防止削波失真
  - **Reverb** - 卷积混响（Mix/Decay/Pre-Delay），模拟空间混响效果
  - **Delay** - 反馈延迟线（Time/Feedback/Mix），回声效果
  - **Crossfeed** - 交叉馈送（Level），耳机听感优化，模拟音箱串音
  - **Stereo Widen** - 立体声展宽（Width），增强声场宽度
  - **Tremolo** - 颤音效果（Rate/Depth），音量周期性调制
  - **Pan** - 声像控制（L/R 平衡）
  - **频谱分析器** - 实时频谱可视化

## 安装方式

### 方式一：从 VSCode 扩展市场安装（推荐）

1. 打开 VSCode，进入扩展面板（`Ctrl+Shift+X`）
2. 搜索 **music-radio**
3. 点击安装

或直接访问 [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=Echo-Denia.music-radio) 页面安装。

### 方式二：命令行安装

```bash
code --install-extension Echo-Denia.music-radio
```

### 方式三：从 VSIX 文件安装

1. 从 [GitHub Releases](https://github.com/Echo-Denia/music-radio/releases) 下载 `.vsix` 文件
2. 打开 VSCode，进入扩展面板（`Ctrl+Shift+X`）
3. 点击扩展面板右上角的 "..." 菜单，选择 "从 VSIX 安装..."
4. 选择下载的 `.vsix` 文件

## 使用方法

### 1. 添加音乐文件夹

- 点击左侧活动栏的 music-radio 图标
- 在音乐库视图中点击 "添加文件夹" 按钮
- 选择包含音乐文件的文件夹

### 2. 播放音乐

- 在音乐库中点击歌曲旁的播放按钮
- 或右键点击歌曲选择 "播放"

### 3. 控制播放

使用命令面板（`Ctrl+Shift+P`）输入以下命令：

- `Music Radio: Open Player` - 打开播放器
- `Music Radio: Play/Pause` - 播放/暂停
- `Music Radio: Next Track` - 下一首
- `Music Radio: Previous Track` - 上一首
- `Music Radio: Toggle Shuffle` - 切换随机播放
- `Music Radio: Toggle Repeat` - 切换循环模式

### 4. 快捷键

可以在 VSCode 的键盘快捷方式设置中自定义快捷键：

```json
{
  "key": "ctrl+alt+p",
  "command": "music-radio.playPause"
}
```

## 配置项

> ⚠️ **重要提示**：播放音乐时请勿关闭播放器的标签页，因为音频播放元素（radio 元素）位于该标签页中，关闭标签页会导致播放停止。

在 VSCode 设置中搜索 "music-radio" 可以配置以下选项：

- **Music Folders** - 音乐文件夹路径列表
- **Volume** - 默认音量（0-100）
- **Shuffle** - 随机播放模式
- **Repeat** - 循环模式（none/all/one）
- **Supported Formats** - 支持的音频格式扩展名

## Music Processor -- 歌词识别、翻译与嵌入流水线

`music_processor.py` 是一个全流程音频处理脚本，用于对本地音乐文件进行歌词识别、翻译以及嵌入。

### 功能概览

- **格式转换**：M4A → MP3（320kbps）转换（通过 ffmpeg）
- **MP3 头修复**：自动检测并修复损坏的 MP3 头部
- **多 GPU 支持**：DataParallel / Model Parallel 策略加速
- **人声分离**：基于 Demucs 的高质量人声提取
- **VAD 智能分段**：pyannote / webrtcvad 双引擎语音活动检测
- **语音识别**：Whisper 歌词转录，支持幻觉检测与回退
- **翻译引擎**：
  - 本地 NLLB-200 / M2M100 离线翻译
  - 兼容 OpenAI 协议的 LLM API 上下文感知翻译
- **歌词嵌入**：MP3（ID3v2.3 SYLT+USLT）/ FLAC（Vorbis Comments），支持章节导航
- **封面匹配**：自动匹配和嵌入专辑封面
- **罗马音生成**：日语假名的罗马音自动转换
- **纯器乐处理**：自动识别并标记纯器乐音轨
- **文件完整性**：音频文件损坏检测、目录对比、MP3/FLAC 匹配迁移

### 运行模式

| 模式 | 名称 | 说明 |
|------|------|------|
| 1 | 视频→音频 | 将 MP4 视频转换为 MP3 音频 |
| 2 | 处理歌词 | 完整流水线：识别、翻译、嵌入歌词和封面 |
| 3 | 验证文件完整性 | 检查音频文件是否损坏 |
| 4 | 合并音视频 | 将 MP3 音频与 MP4 视频合并 |
| 5 | 目录对比 | 找出两个目录间的差异文件 |
| 6 | 文件完整性检查 | 检查封面和元数据完整性 |
| 7 | 日语→罗马音 | 给歌词添加罗马音标注 |
| 8 | 查看嵌入歌词 | 显示音频文件中内嵌的歌词 |
| 9 | MP3↔FLAC 匹配迁移 | 模糊匹配 MP3 并替换为 FLAC |

### 环境搭建

使用项目根目录的 `environment.yml` 一键创建 conda 环境：

```bash
conda env create -f environment.yml
conda activate index-tts
```

环境包含的依赖：Python 3.10、ffmpeg、PyTorch、Whisper、Demucs、transformers、pyannote 等。

### 配置方式

所有敏感信息（路径、API Key）通过以下任一方式配置，**脚本本身不含任何硬编码的路径或密钥**：

#### 方式一：环境变量

```bash
export MUSIC_BASE_DIR="/path/to/your/music"
export MUSIC_DOWNLOAD_DIR="/path/to/downloads"
export MUSIC_MODELS_DIR="/path/to/models"
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://api.example.com/v1"
```

#### 方式二：YAML 配置文件

在 `script/` 目录下创建 `config.yaml`：

```yaml
mode: 2
paths:
  base_dir: /path/to/music
  input_paths:
    - /path/to/music/file.flac
    - /path/to/music/folder
processing:
  whisper_model_size: large-v3
  target_language: zh
gpu:
  enabled: true
  strategy: auto
```

#### 方式三：命令行参数

```bash
python script/music_processor.py --mode 2 --input /path/to/music
```

### 使用示例

```bash
# 处理歌词（模式 2）：识别 + 翻译 + 嵌入
python script/music_processor.py --mode 2 --input /path/to/music

# 视频转音频（模式 1）
python script/music_processor.py --mode 1 --work-dir /path/to/work

# 日语歌词加罗马音（模式 7）
python script/music_processor.py --mode 7 --input /path/to/music

# 查看嵌入式歌词（模式 8）
python script/music_processor.py --mode 8 --file /path/to/song.mp3
```

## 开发指南

### 环境要求

- Node.js >= 16
- VSCode >= 1.85.0

### 安装依赖

```bash
npm install
```

### 编译

```bash
npm run compile
```

### 监听模式（自动编译）

```bash
npm run watch
```

### 打包插件

```bash
npm install -g @vscode/vsce
npx vsce package
```

## 技术栈

- TypeScript — VSCode 插件
- VSCode Extension API
- music-metadata — 音频元数据解析
- Python — 音频后处理流水线（Whisper, Demucs, Transformers）

## 许可证

[MIT License](LICENSE)

## 问题反馈

如有问题或建议，请在 [GitHub Issues](https://github.com/Echo-Denia/music-radio/issues) 提交。
