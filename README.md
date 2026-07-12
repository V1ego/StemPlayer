# ilya — AI 分轨播放器

> 「声を聞かせて。」—— 绫波丽

灵感源于 **Kanye West 的 STEM PLAYER**，融合 **《EVA》绫波丽** 的极简与疏离气质。

加载任意歌曲，AI 自动将其分离为**四条独立音轨**——人声、鼓、贝斯、其他。每条音轨可独立控制音量、静音、独奏。配合基于实时音频分析的**生成艺术可视化**，让声音不仅是听的，也是看的。

「ilya」——既是致敬，也是一次追问：**当一首歌被拆解成纯粹的零件，它还是原来那首歌吗？**

绫波丽那句经典台词「声を聞かせて」（让我听听你的声音）作为开篇，跟分轨播放器的概念天然契合——她想听见的，正是被拆解后每一层最纯净的声音。

---

## 功能

- **AI 分轨分离** — 基于 Demucs（htdemucs 模型），将任意音频分离为 4 条独立分轨
- **独立音轨控制** — 5 档音量调节、静音、独奏，每条分轨各自掌控
- **生成艺术可视化** — p5.js 驱动的实时音频可视化，随频率变化生成动态画面
- **网易云音乐集成** — 扫码登录，浏览歌单，单曲 / 批量 / 播放全部一键分离
- **后台预分离** — 当前歌曲播放时，后台自动分离下一首，播完无缝切换
- **文件上传** — 拖放或点击上传（MP3 / WAV / M4A / FLAC / OGG / AAC / NCM）
- **内置示例** — 两首合成器示例曲目（夜曲 / 冲击 808），开箱即体验
- **键盘快捷键** — Space 播放/暂停，Esc 关闭面板
- **即开即用** — 单文件 exe，免安装

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vanilla JS · Web Audio API · p5.js |
| 后端 | Python Flask · Demucs (PyTorch) |
| 桌面 | Electron |
| 音乐源 | NeteaseCloudMusicApi (Node.js) |

---

## 开发

### 环境要求

- Python 3.11+
- Node.js 18+
- FFmpeg（共享库）

### 启动

```bash
# 安装 Python 依赖
python -m venv .venv
.venv\Scripts\activate   # Windows

# 启动
python resources/app/run.py
```

打开 http://127.0.0.1:5000

### 打包

```bash
cd resources/app
npm run build
```

---

## 项目结构

```
StemPlayer/
├── ilya.exe                    # 打包后的桌面应用
├── resources/
│   ├── app/
│   │   ├── electron/main.js    # Electron 主进程
│   │   ├── app/                # Python Flask 后端
│   │   │   ├── server.py       # 路由 & API
│   │   │   ├── jobs.py         # 任务队列（Demucs 分离）
│   │   │   ├── ncm.py          # NCM 文件解密
│   │   │   └── config.py       # 配置
│   │   ├── static/             # 前端资源
│   │   │   ├── index.html
│   │   │   ├── css/style.css
│   │   │   └── js/             # app.js · audio-engine.js · viz.js · ui.js · netease.js · demo-synth.js · utils.js
│   │   ├── run.py              # 入口
│   │   └── netease_proxy.js    # 网易云 API 代理
│   └── .ffmpeg/                # FFmpeg 共享库
├── .gitignore
├── LICENSE
└── README.md
```

---

## 许可

MIT