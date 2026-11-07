#!/usr/bin/env python3
"""看 B 站视频：拿元信息 + 下视频 + 抽帧 + 写一份能读的报告。

抽帧两种模式：
  场景优先（默认）  先扫全片找「画面大幅变化」的时刻，优先抓这些；抓不满 3 张
                   （纯静态的录屏、单镜头的口播）才退回均匀抽帧。
  均匀（--uniform）按固定间隔抓 N 张。

为什么默认改成场景优先：均匀抽帧在运镜慢、镜头长的视频上会连着抓好几张几乎一样
的画面，而关键信息（刚切到的图表、突然弹出的报错、片尾那行字）常常只出现在切镜的
那一两秒里。均匀是「按时间摊」，场景是「按变化挑」。

用法：
    python look.py BV1ofnD64Eyv
    python look.py BV1ofnD64Eyv --frames 8
    python look.py BV1ofnD64Eyv --uniform        # 强制均匀
    python look.py BV1ofnD64Eyv --scene 0.2      # 降低变化门槛，抓更多细小切换

产物落在 <脚本目录>/out/<BV>/ 下：
    video.mp4   原始视频（360P，省带宽）
    frames/     抽出来的帧，文件名带秒数，如 f03_012.4s.png
    report.md   标题/简介/时长/帧清单

声音这条路走不了（没有 ASR）。看完 report.md 再用 read_image 逐帧看画面。
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
ROOT = Path(__file__).resolve().parent


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def http_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def pick_bvid(text):
    m = re.search(r"(BV[0-9A-Za-z]{10})", text)
    if not m:
        sys.exit("没认出 BV 号：" + text)
    return m.group(1)


def fmt_dur(sec):
    return f"{sec // 60} 分 {sec % 60} 秒"


def scene_times(ff, mp4, threshold):
    """扫一遍，返回画面大幅变化的时间点（秒）。只解码不写盘，比逐帧快得多。"""
    p = subprocess.run(
        [ff, "-hide_banner", "-i", str(mp4),
         "-vf", f"select='gt(scene,{threshold})',showinfo",
         "-vsync", "vfr", "-f", "null", "-"],
        capture_output=True, text=True, errors="ignore",
    )
    return [float(x) for x in re.findall(r"pts_time:\s*([0-9.]+)", p.stderr)]


def pick_points(times, n, dur):
    """把全片切成 n 个等宽窗口，每个窗口取一个时刻。

    窗口里有画面变化就取离窗口中心最近的那个变化点（既覆盖时段、又优先切镜），
    没有变化的窗口退回窗口中心。这样不会出现「变化点全堆在最后 90 秒」——
    那是按变化点数量的均匀，不是按时间的均匀。
    """
    if n <= 0 or dur <= 0:
        return []
    picked = []
    for i in range(n):
        lo, hi = i * dur / n, (i + 1) * dur / n
        mid = (lo + hi) / 2
        cand = [t for t in times if lo <= t < hi]
        picked.append(min(cand, key=lambda t: abs(t - mid)) if cand else mid)
    return picked


def grab_live(room, n, interval):
    """抓直播的当前画面：n 张，间隔 interval 秒。直播没有「看完」这回事，只能取一段。"""
    import imageio_ffmpeg

    info = http_json(f"https://api.live.bilibili.com/room/v1/Room/get_info?room_id={room}")
    if info.get("code"):
        sys.exit(f"取直播间信息失败：{info.get('code')} {info.get('message')}")
    d = info["data"]
    if d.get("live_status") != 1:
        sys.exit(f"房间 {room} 当前没在播（live_status={d.get('live_status')}）")

    play = http_json(
        f"https://api.live.bilibili.com/room/v1/Room/playUrl?cid={room}&quality=4&platform=web"
    )
    if play.get("code"):
        sys.exit(f"取直播流失败：{play.get('code')} {play.get('message')}")
    url = play["data"]["durl"][0]["url"]

    out = ROOT / "out" / f"live-{room}"
    frames_dir = out / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    span = max(1, n) * interval

    # 一次性拉一段流再按 fps 抽帧，遇到掐流会整条失败；改成一轮一连接，
    # 每次重新取 playUrl（直播地址带 expires，会过期），单次失败不毁整次抓取。
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    frames = []
    for i in range(max(1, n)):
        f = frames_dir / f"f{i + 1:02d}.png"
        try:
            fresh = http_json(
                f"https://api.live.bilibili.com/room/v1/Room/playUrl?cid={room}&quality=4&platform=web"
            )
            one = (fresh.get("data") or {}).get("durl") or [{}]
            src = one[0].get("url") or url
        except Exception:
            src = url
        subprocess.run(
            [ff, "-hide_banner", "-loglevel", "error", "-y",
             "-rw_timeout", "20000000",
             "-i", src, "-frames:v", "1", "-vf", "scale=720:-1", str(f)],
            capture_output=True,
        )
        if f.exists() and f.stat().st_size > 0:
            frames.append(f)
        if i + 1 < max(1, n):
            import time as _t

            _t.sleep(interval)
    if not frames:
        sys.exit(f"房间 {room} 取不到画面（流地址可能已过期，或该分片拉不到）")
    anchor = (d.get("anchor_info") or {}).get("base_info", {}).get("uname", "")
    lines = [
        f"# 直播 {room}：{d.get('title', '')}",
        "",
    ]
    if anchor:
        lines.append(f"- 主播：{anchor}")
    lines += [
        f"- 在线人气：{d.get('online', '?')}　开播时间：{d.get('live_time', '?')}",
        f"- 抓帧：{len(frames)} 张，间隔 {interval} 秒，覆盖约 {span} 秒",
        "",
        "## 帧",
        "",
    ]
    for i, f in enumerate(frames, 1):
        lines.append(f"{i:02d}. 第 {(i - 1) * interval} 秒　`{f}`")
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    try:
        (out / "result.json").write_text(json.dumps({
            "ok": True,
            "live": room,
            "title": d.get("title", ""),
            "anchor": anchor,
            "online": d.get("online"),
            "liveTime": d.get("live_time"),
            "dir": str(out),
            "report": str(out / "report.md"),
            "frames": [{"t": i * interval, "path": str(f)} for i, f in enumerate(frames)],
            "frameMode": f"直播，间隔 {interval} 秒",
            "asr": None,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass
    print(f"直播  {d.get('title', '')}")
    print(f"帧    {len(frames)} 张 → {frames_dir}")
    print(f"报告  {out / 'report.md'}")
    print(f"结果  {out / 'result.json'}")


def transcribe(ff, mp4, out, model_size="base", max_sec=600):
    """抽音轨 → faster-whisper 转写。返回 [(start, end, text)]。

    两个坑：
    1. huggingface_hub 新版默认走 Xet 存储，hf-mirror 不支持，401；必须 HF_HUB_DISABLE_XET=1。
    2. faster-whisper 传文件路径会调 av.open(metadata_errors=...)，PyAV 版本不认这个参数；
       传 numpy 数组就绕过整条 av 解码链。

    `max_sec=0` 表示不限时长（from 头转到尾）。结果按模型名缓存到 out/asr.json，
    同一支视频换个参数重跑不用再等一遍。
    """
    import os

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    cache = out / "asr.json"
    if cache.exists():
        try:
            hit = json.loads(cache.read_text(encoding="utf-8"))
            if hit.get("model") == model_size and isinstance(hit.get("segs"), list):
                print(f"台词  命中缓存（{len(hit['segs'])} 段，模型 {model_size}）")
                return [tuple(x) for x in hit["segs"]]
        except Exception:
            pass

    wav = out / "audio.wav"
    dur_args = ["-t", str(max_sec)] if max_sec else []
    subprocess.run(
        [ff, "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(mp4)] + dur_args + [
         "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(wav)],
        check=True,
    )

    import wave

    import numpy as np
    from faster_whisper import WhisperModel

    with wave.open(str(wav)) as w:
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    model = WhisperModel(model_size, device="cpu", compute_type="int8",
                         download_root=str(ROOT / "asr" / "models"))
    segs, _ = model.transcribe(
        audio, language="zh", vad_filter=True, beam_size=5,
        # 不加这句 base 模型会吐繁体；加了顺便把「大魔形」纠正成「大模型」
        initial_prompt="以下是普通话的句子，请用简体中文。",
    )
    result = [(s.start, s.end, s.text.strip()) for s in segs]
    try:
        cache.write_text(
            json.dumps({"model": model_size, "segs": result}, ensure_ascii=False),
            encoding="utf-8")
    except Exception:
        pass
    return result


def extract_links(text):
    """从评论里抠链接：http(s) 直链 + 裸 github.com/owner/repo。"""
    out = []
    for m in re.finditer(r"https?://[^\s，。、）)】\]\"'<>]+", text):
        out.append(m.group(0).rstrip(".,;!?"))
    for m in re.finditer(r"(?<![/\w])((?:github|gitee)\.com/[\w.-]+/[\w.-]+)", text):
        out.append("https://" + m.group(1).rstrip(".,;!?"))
    return list(dict.fromkeys(out))


def fetch_comments(aid, bvid, n=20):
    """抓评论区。返回 (top, items, 总数)。

    匿名访问的天花板（2026-10-27 实测）：
    - `x/v2/reply/main` 直接 -352 风控；wbi 签名能过，但 mode=3 只给 1–2 条、mode=2 给 3 条。
    - 带 buvid3 也一样；网页 HTML 里没有评论（异步加载）。
    - 老接口 `x/v2/reply` 必须加 `nohot=1`，给 3 条。
    结论：游客最多看到热门前几条。够用来抓「UP 置顶里的仓库地址」这种，不够用来通读。
    """
    url = (f"https://api.bilibili.com/x/v2/reply?type=1&oid={aid}"
           f"&sort=2&ps={max(1, min(n, 49))}&pn=1&nohot=1")
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Referer": f"https://www.bilibili.com/video/{bvid}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception:
        return None, [], 0
    if d.get("code"):
        return None, [], 0

    def norm(c):
        msg = ((c.get("content") or {}).get("message") or "").strip()
        return {
            "like": c.get("like", 0),
            "user": ((c.get("member") or {}).get("uname") or ""),
            "text": msg,
            "links": extract_links(msg),
        }

    data = d.get("data") or {}
    top = data.get("top")
    top = norm(top) if isinstance(top, dict) else None
    items = [norm(c) for c in (data.get("replies") or [])]
    total = ((data.get("page") or {}).get("count")) or 0
    return top, items, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?", help="BV 号或视频链接")
    ap.add_argument("--live", metavar="ROOM", help="抓直播房间的当前画面（给房间号）")
    ap.add_argument("--interval", type=int, default=10, help="直播抓帧间隔秒数（默认 10）")
    ap.add_argument("--frames", type=int, default=16, help="最多抽多少帧（默认 16）")
    ap.add_argument("--qn", type=int, default=16, help="清晰度，16=360P（默认），32=480P")
    ap.add_argument("--uniform", action="store_true", help="强制均匀抽帧")
    ap.add_argument("--scene", type=float, default=0.30, help="场景变化门槛，0-1，越小越敏感（默认 0.30）")
    ap.add_argument("--asr", action="store_true", help="顺带转写人声（本地 whisper，慢但免费）")
    ap.add_argument("--model", default="small",
                    help="转写模型：tiny/base/small/medium（默认 small，base 对术语太差）")
    ap.add_argument("--asr-max", type=int, default=0,
                    help="只转写前 N 秒（0=不限，默认 0 从头转到尾）")
    ap.add_argument("--comments", type=int, default=20, help="抓评论区前 N 条热度（0=不抓，默认 20）")
    args = ap.parse_args()

    if args.live:
        # 房间号会拼进 out/live-<room> 并被 rmtree，只收纯数字
        if not args.live.isdigit():
            ap.error(f"--live 只接受数字房间号，收到 {args.live!r}")
        grab_live(args.live, args.frames, args.interval)
        return
    if not args.target:
        ap.error("要给 BV 号，或者用 --live <房间号>")

    bvid = pick_bvid(args.target)
    meta = http_json(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
    if meta.get("code"):
        sys.exit(f"取元信息失败：{meta.get('code')} {meta.get('message')}")
    d = meta["data"]
    cid, dur = d["cid"], d.get("duration", 0)
    aid = d.get("aid", 0)
    title, desc = d["title"], (d.get("desc") or "").strip()
    owner = d.get("owner", {}).get("name", "")
    stat = d.get("stat", {})

    out = ROOT / "out" / bvid
    out.mkdir(parents=True, exist_ok=True)

    # 1. 拿直链并下载
    play = http_json(
        f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}"
        f"&qn={args.qn}&fnval=0&platform=html5"
    )
    if play.get("code"):
        sys.exit(f"取播放地址失败：{play.get('code')} {play.get('message')}")
    purl = play["data"]["durl"][0]["url"]
    mp4 = out / "video.mp4"
    if not mp4.exists() or mp4.stat().st_size == 0:
        mp4.write_bytes(http_bytes(purl))
    size_mb = mp4.stat().st_size / 1024 / 1024

    # 2. 抽帧
    import imageio_ffmpeg

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    frames_dir = out / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir()
    n = max(3, min(args.frames, max(3, dur // 3)))

    picked, mode = [], "均匀"
    if not args.uniform:
        raw = scene_times(ff, mp4, args.scene)
        hits = [t for t in raw if 0.0 <= t < dur]
        if len(hits) >= 3:
            picked = pick_points(hits, n, dur)
            mode = f"场景优先（全片 {len(hits)} 处变化）"
        else:
            picked = []

    if not picked:
        step = max(1.0, dur / n)
        picked = [i * step for i in range(n)]
        mode = "均匀"

    frames = []
    for i, t in enumerate(picked, 1):
        f = frames_dir / f"f{i:02d}_{t:06.1f}s.png"
        subprocess.run(
            [ff, "-hide_banner", "-loglevel", "error", "-y",
             "-ss", f"{t:.3f}", "-i", str(mp4),
             "-frames:v", "1", "-vf", "scale=720:-1", str(f)],
            check=True,
        )
        if f.exists():
            frames.append((t, f))

    # 2.5 转写人声（可选）
    asr_lines = []
    if args.asr:
        try:
            import time as _time

            _t0 = _time.time()
            segs = transcribe(ff, mp4, out, args.model, args.asr_max)
            total = sum(len(t) for _, _, t in segs)
            asr_lines = [f"[{a:6.1f}-{b:6.1f}] {t}" for a, b, t in segs]
            if total < 8:
                asr_lines = ["（几乎没有识别出人声——这条片子可能只有配乐，没有解说）"] + asr_lines
            print(f"台词  {len(segs)} 段 / {total} 字（{_time.time() - _t0:.1f}s，模型 {args.model}）")
        except Exception as e:  # 转写失败不该毁掉整份报告
            asr_lines = [f"（转写失败：{type(e).__name__}: {e}）"]
            print(f"台词  失败：{type(e).__name__}: {e}")

    # 3. 写报告
    lines = [
        f"# {title}",
        "",
        f"- BV：{bvid}　UP：{owner}",
        f"- 时长：{fmt_dur(dur)}（{dur} 秒）　文件：{size_mb:.2f} MB",
        f"- 播放 {stat.get('view', 0)}　弹幕 {stat.get('danmaku', 0)}　评论 {stat.get('reply', 0)}　收藏 {stat.get('favorite', 0)}",
        "",
        "## 简介",
        "",
        desc if desc else "（无）",
        "",
        f"## 帧（{mode}抽帧，共 {len(frames)} 张）",
        "",
    ]
    for i, (t, f) in enumerate(frames, 1):
        lines.append(f"{i:02d}. 第 {t:.1f} 秒　`{f}`")
    if args.asr:
        lines += ["", f"## 台词（whisper-{args.model} 自动转写，可能有错字）", ""] + asr_lines
    if args.comments and aid:
        top, items, total = fetch_comments(aid, bvid, args.comments)
        lines += ["", "## 评论区", ""]
        if top is None and not items:
            lines.append("（接口没给数据，可能被风控或关评）")
        else:
            all_links = []
            for c in ([top] if top else []) + items:
                all_links += c["links"]
            all_links = list(dict.fromkeys(all_links))
            if all_links:
                lines += ["**评论里的链接**（常藏仓库地址，先看这段）：", ""]
                lines += [f"- {u}" for u in all_links]
                lines += [""]
            if top:
                star = "★" if top["links"] else "·"
                lines.append(f"{star} [置顶] 赞 {top['like']} @{top['user']}：{top['text']}".replace("\n", " "))
            for c in items:
                star = "★" if c["links"] else "·"
                txt = c["text"].replace("\n", " ")
                if len(txt) > 220:
                    txt = txt[:220] + "…"
                lines.append(f"{star} 赞 {c['like']} @{c['user']}：{txt}")
            shown = len(items) + (1 if top else 0)
            note = f"（视频共 {total} 条评论，匿名只拿到 {shown} 条热门；要全量得带登录态）"
            lines += ["", note]
            print(f"评论  {shown} 条 / 共 {total}，{sum(1 for c in ([top] if top else []) + items if c['links'])} 条带链接")
    report = out / "report.md"
    report.write_text("\n".join(lines), encoding="utf-8")

    # 给插件/程序读的结构化结果（stdout 有编码坑，写文件最稳）
    try:
        (out / "result.json").write_text(json.dumps({
            "ok": True,
            "bvid": bvid,
            "title": title,
            "owner": owner,
            "duration": dur,
            "url": f"https://www.bilibili.com/video/{bvid}",
            "dir": str(out),
            "report": str(report),
            "frames": [{"t": t, "path": str(f)} for t, f in frames],
            "frameMode": mode,
            "asr": asr_lines if args.asr else None,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass

    print(f"视频  {mp4}  ({size_mb:.2f} MB)")
    print(f"帧    {len(frames)} 张（{mode}）→ {frames_dir}")
    print(f"报告  {report}")
    print(f"结果  {out / 'result.json'}")


if __name__ == "__main__":
    main()
