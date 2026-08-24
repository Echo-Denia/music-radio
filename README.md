<!-- @format -->

# Music Radio - VSCode 音乐播放器

一款在 VSCode 中运行的音乐播放器插件，支持实时歌词显示。

## 功能特性

- 🎵 **音乐播放** - 支持多种音频格式（MP3, FLAC, WAV, OGG, M4A, AAC, WMA, OPUS, MP4）
- 📝 **实时歌词** - 播放时同步显示音乐文件的内嵌歌词、外挂歌词等，支持显示实时歌词在底边栏便于摸鱼（如果音乐文件有内嵌/外挂实时歌词的话）
- 📂 **音乐库管理** - 添加本地音乐文件夹，自动扫描音乐文件
- 🔀 **播放模式** - 支持随机播放、列表循环、单曲循环
- 🔍 **音乐搜索** - 快速搜索音乐库中的歌曲
- 🎛️ **播放控制** - 播放/暂停、上一首/下一首、音量调节，支持在底边栏控制播放情况，便于摸鱼
- 📋 **播放列表** - 支持播放下一首、移除歌曲、清空列表

## 安装方式

### 方式一：从 VSIX 文件安装

1. 下载 `.vsix` 文件
2. 打开 VSCode，进入扩展面板（Ctrl+Shift+X）
3. 点击扩展面板右上角的 "..." 菜单
4. 选择 "从 VSIX 安装..."
5. 选择下载的 `.vsix` 文件

### 方式二：命令行安装

```bash
code --install-extension vscode-music-radio-0.1.0.vsix
```

## 使用方法

### 1. 添加音乐文件夹

- 点击左侧活动栏的 Music Radio 图标
- 在音乐库视图中点击 "添加文件夹" 按钮
- 选择包含音乐文件的文件夹

### 2. 播放音乐

- 在音乐库中点击歌曲旁的播放按钮
- 或右键点击歌曲选择 "播放"

### 3. 控制播放

使用命令面板（Ctrl+Shift+P）输入以下命令：

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

> ⚠️ **重要提示**：播放音乐时请勿关闭播放器的标签页，因为音频播放元素（radio元素）位于该标签页中，关闭标签页会导致播放停止。

在 VSCode 设置中搜索 "Music Radio" 可以配置以下选项：

- **Music Folders** - 音乐文件夹路径列表
- **Volume** - 默认音量（0-100）
- **Shuffle** - 随机播放模式
- **Repeat** - 循环模式（none/all/one）
- **Supported Formats** - 支持的音频格式扩展名

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

- TypeScript
- VSCode Extension API
- music-metadata（音频元数据解析）

## 许可证

MIT License

## 问题反馈

如有问题或建议，请提交 Issue。
