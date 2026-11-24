# -*- coding: utf-8 -*-
"""
生成 exe 图标（tools/app.ico，多尺寸 256/128/64/48/32/16）。

设计：深青底 + 层叠山脊 + 一条发光的江。与主界面配色（#0B1A21 / #37D9A0 / #57E6C8）一致，
缩到 16 px 仍能分辨"山 + 江"，不做细碎纹理（那在任务栏会糊成一团）。

用法
  python tools/make_icon.py
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tools', 'app.ico')
S = 512          # 先画大图再降采样，边缘更干净
R = 108          # 圆角半径（按 512 计）


def rr_mask(size, r):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def vgrad(size, top, bot):
    img = Image.new('RGB', (1, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size))


def ridge(draw, w, h, base, amp, color, phase=0.0, steps=96):
    pts = [(0, h)]
    for i in range(steps + 1):
        x = w * i / steps
        t = i / steps * math.pi * 2
        peak = abs(math.sin(t * 1.15 + phase)) ** 0.62
        micro = 0.16 * abs(math.sin(t * 4.7 + phase * 2.3)) ** 0.5
        y = base - amp * (0.30 + 0.70 * peak + micro)
        pts.append((x, y))
    pts.append((w, h))
    draw.polygon(pts, fill=color)


img = vgrad(S, (11, 26, 33), (9, 18, 24)).convert('RGBA')
d = ImageDraw.Draw(img)

# 极淡的网格，暗示经纬/地形
for i in range(1, 8):
    a = 10 if i % 2 else 6
    d.line([(0, S * i / 8), (S, S * i / 8)], fill=(55, 217, 160, a), width=1)
    d.line([(S * i / 8, 0), (S * i / 8, S)], fill=(55, 217, 160, a), width=1)

# 三层山脊：远山暗、近山亮
ridge(d, S, S, int(S * 0.56), int(S * 0.20), (18, 58, 58, 255), 0.6)
ridge(d, S, S, int(S * 0.64), int(S * 0.17), (23, 86, 80, 255), 2.1)
ridge(d, S, S, int(S * 0.72), int(S * 0.14), (31, 132, 116, 255), 4.0)

# 山脊高光线
hi = Image.new('RGBA', (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(hi)
for phase, base, amp, wd in ((0.6, .56, .20, 3), (2.1, .64, .17, 3), (4.0, .72, .14, 4)):
    pts = []
    for i in range(97):
        x = S * i / 96
        t = i / 96 * math.pi * 2
        peak = abs(math.sin(t * 1.15 + phase)) ** 0.62
        micro = 0.16 * abs(math.sin(t * 4.7 + phase * 2.3)) ** 0.5
        y = S * base - S * amp * (0.30 + 0.70 * peak + micro)
        pts.append((x, y))
    hd.line(pts, fill=(87, 230, 200, 210), width=wd, joint='curve')
hi = hi.filter(ImageFilter.GaussianBlur(1.2))
img.alpha_composite(hi)

# 江：一条自左上向右下的发光曲线
river = Image.new('RGBA', (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(river)
path = []
for i in range(121):
    t = i / 120
    x = S * (0.06 + 0.92 * t)
    y = S * (0.90 - 0.30 * t + 0.10 * math.sin(t * math.pi * 2.2))
    path.append((x, y))
rd.line(path, fill=(120, 245, 220, 255), width=17, joint='curve')
glow = river.filter(ImageFilter.GaussianBlur(9))
img.alpha_composite(glow)
img.alpha_composite(river)
core = Image.new('RGBA', (S, S), (0, 0, 0, 0))
cd = ImageDraw.Draw(core)
cd.line(path, fill=(235, 255, 250, 255), width=5, joint='curve')
img.alpha_composite(core.filter(ImageFilter.GaussianBlur(0.6)))

# 外框：1.5 px 亮边 + 内发光
frame = Image.new('RGBA', (S, S), (0, 0, 0, 0))
fd = ImageDraw.Draw(frame)
fd.rounded_rectangle([6, 6, S - 7, S - 7], radius=R - 3, outline=(90, 240, 205, 235), width=3)
img.alpha_composite(frame.filter(ImageFilter.GaussianBlur(3)))
fd2 = ImageDraw.Draw(img)
fd2.rounded_rectangle([6, 6, S - 7, S - 7], radius=R - 3, outline=(120, 250, 220, 150), width=2)

# 圆角裁切
img.putalpha(rr_mask(S, R))

sizes = [256, 128, 64, 48, 32, 16]
img.resize((256, 256), Image.LANCZOS).save(OUT, format='ICO',
                                           sizes=[(s, s) for s in sizes])
print('已生成 %s（%d 字节，尺寸 %s）' % (OUT, os.path.getsize(OUT), sizes))
png = os.path.join(ROOT, 'tools', 'app_icon_256.png')
img.resize((256, 256), Image.LANCZOS).save(png)
print('预览图 %s' % png)
