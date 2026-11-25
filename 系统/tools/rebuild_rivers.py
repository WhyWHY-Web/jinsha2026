# -*- coding: utf-8 -*-
"""
从 streams.json（DEM D8 提取的 679 条真实河网）重新构建 hydro.json。

解决的问题：
- 原 hydro.json 的「金沙江主流」只到攀枝花（101.79°E/26.60°N）就断了，
  下游段（攀枝花→宜宾）在 D8 提取时断裂，被误当成「支流2」，
  导致三维图里金沙江主线走向与真实河流不符。
- 本脚本：干流 = streams 上段（源头→攀枝花，真实蜿蜒） + SPINE 下游段
  （攀枝花→宜宾，真实站点走向，补齐 D8 断裂段）；支流 = streams 其余长线。

只读 data/streams.json，写 data/hydro.json。条数与源逐条核对。
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'data')

# 金沙江干流下游段（攀枝花→宜宾），真实站点走向（lon, lat），
# 与 app.html 内 SPINE 控制点一致（攀枝花及之后）。
SPINE_DOWNSTREAM = [
    [101.72, 26.58],   # 攀枝花
    [102.10, 26.05],
    [102.38, 26.22],   # 皎平渡
    [102.62, 26.35],
    [102.93, 26.92],   # 巧家
    [103.25, 27.55],
    [103.66, 28.24],   # 溪洛渡
    [103.97, 28.59],   # 绥江
    [104.40, 28.65],   # 向家坝
    [105.05, 28.82],   # 宜宾（与岷江汇合）
]


def densify(pts, seg):
    """折线加密（与前端 rvDensify 同思路）。"""
    out = []
    for i in range(len(pts) - 1):
        for k in range(seg):
            t = k / seg
            out.append([pts[i][0] + (pts[i+1][0] - pts[i][0]) * t,
                        pts[i][1] + (pts[i+1][1] - pts[i][1]) * t])
    out.append(pts[-1])
    return out


def chaikin(pts, passes=2):
    """Chaikin 平滑，去掉 D8 八方向锯齿与拼接折角。"""
    out = pts
    for _ in range(passes):
        if len(out) < 3:
            break
        q = [out[0]]
        for i in range(1, len(out) - 1):
            q.append([(out[i-1][0] + out[i][0]*2 + out[i+1][0]) / 4,
                      (out[i-1][1] + out[i][1]*2 + out[i+1][1]) / 4])
        q.append(out[-1])
        out = q
    return out


def thin(pts, target):
    """均匀抽稀到约 target 个点（保留首尾）。"""
    n = len(pts)
    if n <= target:
        return pts
    step = (n - 1) / (target - 1)
    out = [pts[0]]
    for i in range(1, target - 1):
        out.append(pts[int(round(i * step))])
    out.append(pts[-1])
    return out


def line_len(pts):
    """近似长度（度），lon 乘 cos(lat) 粗略校正。"""
    s = 0.0
    for i in range(1, len(pts)):
        lat = (pts[i-1][1] + pts[i][1]) / 2
        import math
        dx = (pts[i][0] - pts[i-1][0]) * math.cos(math.radians(lat))
        dy = pts[i][1] - pts[i-1][1]
        s += math.hypot(dx, dy)
    return s


def main():
    src = json.load(open(os.path.join(DATA, 'streams.json'), encoding='utf-8'))
    lines = src['lines']  # 每条 [点数, [[lon,lat],...]]
    n_src = len(lines)
    thr = src.get('thr')

    # 按点数（=线长）降序排序
    lines = sorted(lines, key=lambda l: -len(l[1]))

    # 最长线 = 金沙江干流上段（源头→攀枝花）
    main_pts = lines[0][1]
    print('干流上段: %d 点 首=%s 末=%s' % (len(main_pts), main_pts[0], main_pts[-1]))

    # 上段：抽稀到 ~600 点
    upper = thin(main_pts, 600)
    # 下游段：SPINE 10 点先加密到 ~80 点再平滑（保留皎平渡/巧家/溪洛渡等弯曲）
    lower = densify(SPINE_DOWNSTREAM, 9)   # 10 点 → 约 91 点
    lower = chaikin(lower, 3)
    lower = thin(lower, 80)

    # 拼接（下游段首点=攀枝花，与上段末点几乎重合，直接相接）
    main = upper + lower
    # 衔接处 + 整体轻度平滑一次，消除攀枝花折角
    main = chaikin(main, 1)
    main = thin(main, 680)
    main_len = line_len(main)
    print('干流拼接后: %d 点 首=%s 末=%s 长度≈%.1f°' % (
        len(main), [round(x, 3) for x in main[0]], [round(x, 3) for x in main[-1]], main_len))

    rivers = [{'nm': '金沙江', 'lvl': 1, 'len': round(main_len, 2), 'p': [[round(a, 5), round(b, 5)] for a, b in main]}]

    # 支流：其余 >250 点的线
    TRIB_MIN = 250
    tribs = [l for l in lines[1:] if len(l[1]) > TRIB_MIN]
    print('支流候选: %d 条 (>%d 点)' % (len(tribs), TRIB_MIN))

    for idx, l in enumerate(tribs):
        pts = l[1]
        # 抽稀到最多 300 点，轻度平滑
        p = thin(pts, 300)
        p = chaikin(p, 1)
        ln = line_len(p)
        lvl = 2 if len(pts) >= 1000 else 3  # 一级/二级支流
        rivers.append({'nm': '支流%d' % (idx + 1), 'lvl': lvl, 'len': round(ln, 2),
                       'p': [[round(a, 5), round(b, 5)] for a, b in p]})

    out = {
        'meta': {
            'bbox': [97.6, 25.9, 105.4, 32.5],
            'note': ('金沙江干流 = streams D8 上段(源头→攀枝花) + 真实站点下游段(攀枝花→宜宾)，'
                     '补齐 D8 在下游深切峡谷的断裂；支流 = streams D8 真实河网(>%d点)。' % TRIB_MIN),
            'nTrib': len(tribs),
            'mainLen': round(main_len, 2),
            'srcLines': n_src,
            'thr': thr,
        },
        'rivers': rivers,
    }

    dst = os.path.join(DATA, 'hydro.json')
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('写入 %s' % dst)
    print('总计 %d 条河（1 干流 + %d 支流），源 %d 条线' % (len(rivers), len(tribs), n_src))


if __name__ == '__main__':
    main()
