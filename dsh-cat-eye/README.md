# dsh-cat-eye

让 DSH 自己看 B 站：给一个 BV 号或直播间，它下视频、按场景抽帧、可以转写人声、可以抓热门评论，然后把一份报告交回来。

## 工具

| 工具 | 参数 |
|---|---|
| `look_bili` | `target`（BV 号 / 链接 / 直播房间号，必填）、`live`、`frames`、`interval`、`asr`、`model`、`comments` |

## 依赖

- Python 3.11+，`pip install imageio-ffmpeg`（自带 ffmpeg，约 25 MB）
- 转写另需 `pip install faster-whisper`（约 150 MB 模型，首次下载）
- 全程走 `tools/look.py`，脚本和工具共用一份实现

## 用法

```
look_bili(target="BV1xx", frames=12, asr=True, comments=5)
look_bili(target="6", live=True, frames=2, interval=4)
```

## 边界

- 匿名接口拿不到 AI 字幕，热门评论只给 1–3 条（要全量得登录态）
- 转写会错字，术语密集的片子用 `model="small"`；音乐和人声分不开
- 只读公开内容，不改动 B 站账号任何东西

## 来源

自建。协议 MIT。
