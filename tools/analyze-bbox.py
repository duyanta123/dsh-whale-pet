# -*- coding: utf-8 -*-
"""鲸鱼娘桌宠 · 二期逐状态 bbox 热区表生成工具（PIL alpha 扫描）。

扫描 assets/musume/*.webp 的**首帧**不透明像素 bbox，归一化到 [0,1]，
输出 lib/client/bbox-table.json（入库，运行时由 lib/client/bbox.mjs 消费）。

决策依据：refs/whale-girl decisions/implemented/bug-fix/2026-08-09-hitarea-follows-state.md
—— 热区跟随当前状态（逐状态 bbox 取代全状态并集）、**只取首帧**（多帧 sheet 会把
第 2..N 帧内容跨度计入 bbox 撑大热区）、flip 镜像时 x 需镜像（whale-girl「热区按内容
实际位置对齐（flip 镜像）」条）。本库素材为整段动画 WebP（时序内嵌），「首帧」即
PIL 的第 0 帧；帧间内容跨度不同属预期，取首帧是与 whale-girl 同源的有意裁定。

阈值口径：alpha >= ALPHA_MIN（默认 8）视为不透明像素——排除抗锯齿/外发光的
近透明边缘，避免热区被肉眼不可见像素撑大；素材本身不做任何修改。

用法（仓库根目录）：
    python tools/analyze-bbox.py            # 全量扫描 assets/musume/*.webp
    python tools/analyze-bbox.py --check    # 只校验现表与扫描结果一致（CI 可用）
输出：lib/client/bbox-table.json
    { "_meta": {...口径说明...}, "files": { "<basename>.webp": {x0,y0,x1,y1}, ... } }
坐标为帧内归一化 [0,1]，保留 4 位小数；全透明帧输出 null（调用方回退静态热区表）。
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSET_DIR = REPO_ROOT / "assets" / "musume"
OUT_FILE = REPO_ROOT / "lib" / "client" / "bbox-table.json"

ALPHA_MIN = 8          # alpha >= 8 视为不透明（排除近透明边缘）
ROUND_DIGITS = 4       # 归一化坐标保留位数
VERSION = 1            # 表结构版本（消费方 bbox.mjs 按版本兼容）


def frame_bbox(path: Path):
    """取动画 WebP 首帧的不透明像素 bbox，返回归一化 {x0,y0,x1,y1} 或 None（全透明）。"""
    with Image.open(path) as im:
        # 只取首帧：seek(0) 显式落在第 0 帧（whale-girl 2026-08-09 决策的「只取首帧」口径）。
        try:
            im.seek(0)
        except EOFError:
            pass
        frame = im.convert("RGBA")
        alpha = frame.getchannel("A")
        mask = alpha.point(lambda a: 255 if a >= ALPHA_MIN else 0)
        box = mask.getbbox()  # (l, t, r, b)；全透明 → None
        if box is None:
            return None
        w, h = frame.size
        l, t, r, b = box
        # r/b 是排他边界（getbbox 语义），除以宽高即 [0,1] 归一化。
        return {
            "x0": round(l / w, ROUND_DIGITS),
            "y0": round(t / h, ROUND_DIGITS),
            "x1": round(r / w, ROUND_DIGITS),
            "y1": round(b / h, ROUND_DIGITS),
        }


def scan():
    files = {}
    for path in sorted(ASSET_DIR.glob("*.webp")):
        try:
            files[path.name] = frame_bbox(path)
        except Exception as exc:  # 单文件损坏不拖垮全表：记 null 回退静态表
            print(f"[warn] {path.name}: {exc}", file=sys.stderr)
            files[path.name] = None
    return files


def main():
    parser = argparse.ArgumentParser(description="生成逐状态 bbox 热区表")
    parser.add_argument("--check", action="store_true", help="只校验现表与扫描结果一致")
    args = parser.parse_args()

    files = scan()
    table = {
        "_meta": {
            "version": VERSION,
            "tool": "tools/analyze-bbox.py",
            "alphaMin": ALPHA_MIN,
            "frame": "first",  # 只取首帧（whale-girl 2026-08-09 决策口径）
            "coords": "normalized [0,1] of frame; x 镜像（flip=-1）由消费方 bbox.mjs 运行时处理",
            "source": "assets/musume/*.webp 首帧 alpha>=8 不透明像素 bbox",
        },
        "files": files,
    }
    payload = json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if args.check:
        current = OUT_FILE.read_text(encoding="utf-8") if OUT_FILE.exists() else ""
        if current != payload:
            print("bbox-table.json 与扫描结果不一致（需要重新生成）", file=sys.stderr)
            sys.exit(1)
        print(f"check ok: {len(files)} files in sync")
        return

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(payload, encoding="utf-8")
    missing = [name for name, box in files.items() if box is None]
    print(f"written: {OUT_FILE} ({len(files)} files, {len(missing)} empty/transparent)")


if __name__ == "__main__":
    main()
