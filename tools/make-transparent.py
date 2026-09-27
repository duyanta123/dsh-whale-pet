# 素材透明化处理：
# 1) whale-girl 官方精灵图集(256x256帧横排, 已带alpha) -> 切帧 -> 动画 WebP
# 2) 原画 avatar.png 白底 -> 透明(边缘连通泛洪 + 羽化)
# 3) 大肥鱼 GIF 白底 -> 透明 -> 动画 WebP
import json, os, glob
from collections import deque
from PIL import Image

ROOT = r"D:/桌宠/whale-pet/assets"
UP = r"C:\Users\duyan\AppData\Local\Temp\wg\whale-girl-main"
REMOVE_MIN = 228   # min(r,g,b) >= 该值且与边缘连通 -> 全透明
FEATHER_LO = 200   # 羽化带下限: minc 200->不透明, 228->全透明

def near_white(px, thr):
    r, g, b = px[0], px[1], px[2]
    return min(r, g, b) >= thr and (max(r, g, b) - min(r, g, b)) <= 30

def key_white(im):
    """删除与图像边缘连通的白色背景, 并对边界做羽化."""
    w, h = im.size
    px = im.load()
    q = deque()
    seen = bytearray(w * h)
    for x in range(w):
        for y in (0, h - 1):
            if near_white(px[x, y], REMOVE_MIN) and not seen[y * w + x]:
                seen[y * w + x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if near_white(px[x, y], REMOVE_MIN) and not seen[y * w + x]:
                seen[y * w + x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft()
        px[x, y] = (255, 255, 255, 0)
        for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                p = px[nx, ny]
                if p[3] != 0 and near_white(p, REMOVE_MIN):
                    seen[ny * w + nx] = 1; q.append((nx, ny))
    # 羽化: 与透明区相邻的不透明像素, 按亮度做半透明过渡
    edge = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                continue
            for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
                if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                    edge.append((x, y)); break
    for x, y in edge:
        r, g, b, a = px[x, y]
        minc = min(r, g, b)
        if minc >= FEATHER_LO:
            alpha = max(0, min(255, int((REMOVE_MIN - minc) * 255 / (REMOVE_MIN - FEATHER_LO))))
            px[x, y] = (r, g, b, alpha)
    return im

# ---------- 1) 经典女仆: 图集 -> 动画 WebP ----------
spec = json.load(open(os.path.join(UP, "lib", "assets", "manifest.json"), encoding="utf-8"))
states = spec["characters"]["whale-girl"]["states"]
print("== 1) 切帧 whale-girl sheets ==")
for sheet_path in sorted(glob.glob(os.path.join(UP, "lib", "assets", "characters", "whale-girl", "*.png"))):
    name = os.path.splitext(os.path.basename(sheet_path))[0]
    st = states.get(name, {})
    fps = st.get("fps", 3)
    ms = max(80, round(1000 / fps))
    im = Image.open(sheet_path).convert("RGBA")
    fw = 256
    n = im.size[0] // fw
    frames = [im.crop((i * fw, 0, (i + 1) * fw, im.size[1])) for i in range(n)]
    out = os.path.join(ROOT, "classic", f"{name}.webp")
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=ms, loop=0, quality=90, method=4)
    a = frames[0].getchannel("A").histogram()
    print(f"  {name:14s} {n}帧 {ms}ms/帧 透明{sum(a[:16])/(256*256):.0%} -> {os.path.basename(out)}")

# ---------- 2) 原画 avatar ----------
print("== 2) avatar.png 去白底 ==")
av = Image.open(os.path.join(ROOT, "classic", "avatar.png")).convert("RGBA")
h = av.getchannel("A").histogram()
if sum(h[:16]) / (av.size[0] * av.size[1]) < 0.01:
    av = key_white(av)
    av.save(os.path.join(ROOT, "classic", "avatar.png"))
a = av.getchannel("A").histogram()
print(f"  avatar {av.size} 透明占比 {sum(a[:16])/(av.size[0]*av.size[1]):.0%}")

# ---------- 3) 大肥鱼 GIF -> 透明动画 WebP ----------
print("== 3) fatfish GIF 去白底 ==")
for gif in sorted(glob.glob(os.path.join(ROOT, "fatfish", "*.gif"))):
    name = os.path.splitext(os.path.basename(gif))[0]
    im = Image.open(gif)
    frames, durs = [], []
    for i in range(getattr(im, "n_frames", 1)):
        im.seek(i)
        durs.append(im.info.get("duration", 100))
        frames.append(key_white(im.convert("RGBA").copy()))
    out = os.path.join(ROOT, "fatfish", f"{name}.webp")
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durs, loop=0, quality=90, method=4)
    im.close()
    os.remove(gif)
    a = frames[0].getchannel("A").histogram(); t = frames[0].size[0] * frames[0].size[1]
    print(f"  {name:10s} {len(frames)}帧 首帧透明{sum(a[:16])/t:.0%} -> {os.path.basename(out)}")

print("完成")
