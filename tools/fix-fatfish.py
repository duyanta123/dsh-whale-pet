# 大肥鱼 GIF 修复: 源图为假透明棋盘格(24px 方格, (238,237,237)/(202,201,202)),
# 从帧边缘泛洪键掉两种灰格 + 羽化, 重建透明动画 WebP.
import glob, os
from collections import deque, Counter
from PIL import Image

SRC = glob.glob(r"C:\Users\duyan\AppData\Local\Temp\ff\deepseek-fat-fish-codex-pet-main\assets\*.gif")
OUT = r"D:/桌宠/whale-pet/assets/fatfish"

def key_colors(im, targets, tol=8):
    """删除与帧边缘连通的、颜色接近 targets 的像素; 再羽化边界."""
    w, h = im.size
    px = im.load()
    def match(p):
        return any(abs(p[0]-t[0])<=tol and abs(p[1]-t[1])<=tol and abs(p[2]-t[2])<=tol for t in targets)
    q = deque(); seen = bytearray(w*h)
    for x in range(w):
        for y in (0, h-1):
            if match(px[x,y]) and not seen[y*w+x]: seen[y*w+x]=1; q.append((x,y))
    for y in range(h):
        for x in (0, w-1):
            if match(px[x,y]) and not seen[y*w+x]: seen[y*w+x]=1; q.append((x,y))
    while q:
        x,y = q.popleft()
        px[x,y] = (255,255,255,0)
        for nx,ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0<=nx<w and 0<=ny<h and not seen[ny*w+nx]:
                p = px[nx,ny]
                if p[3]!=0 and match(p): seen[ny*w+nx]=1; q.append((nx,ny))
    # 羽化: 与透明相邻的不透明像素, 按其与两种灰格的距离做半透明
    targets_arr = targets
    for y in range(h):
        for x in range(w):
            p = px[x,y]
            if p[3]==0: continue
            near_bg = any(px[nx,ny][3]==0
                          for nx,ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1))
                          if 0<=nx<w and 0<=ny<h)
            if not near_bg: continue
            d = min(sum(abs(p[i]-t[i]) for i in range(3))/3 for t in targets_arr)
            if d < 24:
                px[x,y] = (p[0],p[1],p[2], int(255 * d/24))
    return im

for gif in sorted(SRC):
    name = os.path.splitext(os.path.basename(gif))[0]
    im = Image.open(gif)
    frames, durs = [], []
    for i in range(getattr(im, "n_frames", 1)):
        im.seek(i)
        durs.append(im.info.get("duration", 100))
        fr = im.convert("RGBA").copy()
        # 取该帧颜色 top2(棋盘格两灰必是主导色)作为键控目标
        cnt = Counter(p for p in fr.getdata())
        targets = [c[:3] for c, _ in cnt.most_common(2)]
        frames.append(key_colors(fr, targets))
    im.close()
    out = os.path.join(OUT, f"{name}.webp")
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durs, loop=0, quality=90, method=4)
    a = frames[0].getchannel("A").histogram(); t = frames[0].size[0]*frames[0].size[1]
    print(f"{name:10s} {len(frames)}帧 目标色{[[list(t2) for t2 in targets]]} 首帧透明{sum(a[:16])/t:.0%}")
print("完成")
