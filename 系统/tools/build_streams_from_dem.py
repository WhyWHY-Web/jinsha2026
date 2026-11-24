# -*- coding: utf-8 -*-
"""从 190m DEM 重新提取河网（D8 流向 + 汇流累积），让河流/支流天然贴合真实沟谷。

流程：读 dem.bin(4096²) → 降采样到 2048² → 优先洪水填洼 → D8 流向 →
按高程降序累积汇流 → 阈值提取河网 → 追踪成折线 → 写 streams.json（与原格式兼容）。
"""
import os, json, heapq, time
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = 97.6, 105.4, 25.9, 32.5
N = 2048
THR = 1500         # 汇流阈值（格点数 ≈ 206 km²），越小支流越密
MIN_LEN = 5        # 少于该点数的河段丢弃（去噪）

t0 = time.time()
raw = np.fromfile(os.path.join(DATA, 'dem.bin'), dtype='<i2').reshape(4096, 4096).astype(np.float32)
# 2×2 盒式降采样 4096² → 2048²（4096 恰为 2048×2）
dem = raw.reshape(N, 2, N, 2).mean(axis=(1, 3))
print('dem downsampled', dem.shape, '%.0f' % dem.min(), '%.0f' % dem.max(), '%.1fs' % (time.time() - t0))

# ---- 1) 优先洪水填洼（Barnes 2014）----
filled = dem.copy()
closed = np.zeros((N, N), dtype=bool)
heap = []
for i in range(N):
    for j in (0, N - 1):
        heapq.heappush(heap, (dem[i, j], i, j))
for j in range(N):
    for i in (0, N - 1):
        heapq.heappush(heap, (dem[i, j], i, j))
nb = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
while heap:
    h, i, j = heapq.heappop(heap)
    if closed[i, j]:
        continue
    closed[i, j] = True
    for di, dj in nb:
        ni, nj = i + di, j + dj
        if 0 <= ni < N and 0 <= nj < N and not closed[ni, nj]:
            if filled[ni, nj] < filled[i, j]:
                filled[ni, nj] = filled[i, j]
            heapq.heappush(heap, (filled[ni, nj], ni, nj))
print('filled sinks %.1fs' % (time.time() - t0))

# ---- 2) D8 流向（最陡下降）----
# 方向编码 1..8 对应 东/东北/北/西北/西/西南/南/东南（行=纬度，col=经度）
F = np.zeros((N, N), dtype=np.int8)
dist = np.array([1, np.sqrt(2), 1, np.sqrt(2), 1, np.sqrt(2), 1, np.sqrt(2)], dtype=np.float32)
pad = np.full((N + 2, N + 2), np.inf, dtype=np.float32)
pad[1:-1, 1:-1] = filled
D8 = [((0, 1), 1), ((-1, 1), 2), ((-1, 0), 3), ((-1, -1), 4),
      ((0, -1), 5), ((1, -1), 6), ((1, 0), 7), ((1, 1), 8)]
doff = {1: (0, 1), 2: (-1, 1), 3: (-1, 0), 4: (-1, -1), 5: (0, -1), 6: (1, -1), 7: (1, 0), 8: (1, 1)}
best_drop = np.full((N, N), -np.inf, dtype=np.float32)
for (di, dj), code in D8:
    nbv = pad[1 + di:1 + di + N, 1 + dj:1 + dj + N]
    drop = (filled - nbv) / dist[code - 1]
    m = drop > best_drop
    F[m] = code
    best_drop[m] = drop[m]
F[best_drop <= 0] = 0   # 平地/无下降 → 先标 0
print('flow direction %.1fs, flats=%d' % (time.time() - t0, int((F == 0).sum())))

# ---- 2.5) 平地流向解析：让填洼产生的平坦区把水导向其下坡出口 ----
from collections import deque
flat = (F == 0)
q = deque()
# 种子：平地格中，凡相邻已解析格(F!=0 且高程<=自身)的，指向该格。
# 注：洼地底部平地的边缘格已指向更低处(F!=0)，只有内部格 F=0，故种子应找"相邻已解析格"。
for i in range(N):
    for j in range(N):
        if F[i, j] != 0:
            continue
        for (di, dj), code in D8:
            ni, nj = i + di, j + dj
            if 0 <= ni < N and 0 <= nj < N and F[ni, nj] != 0 and filled[ni, nj] <= filled[i, j]:
                F[i, j] = code
                q.append((i, j))
                break
# BFS：在同一平地内向外传播，让每个平地格指向已解析的邻格
while q:
    i, j = q.popleft()
    for (di, dj), _ in D8:
        ni, nj = i + di, j + dj
        if 0 <= ni < N and 0 <= nj < N and F[ni, nj] == 0 and filled[ni, nj] == filled[i, j]:
            for code2, (ddi, ddj) in doff.items():
                if ddi == -di and ddj == -dj:
                    F[ni, nj] = code2
                    break
            q.append((ni, nj))
print('flat resolved %.1fs, remaining flats=%d' % (time.time() - t0, int((F == 0).sum())))

# ---- 3) 汇流累积（队列拓扑法：正确处理填洼产生的等高等程平地）----
acc = np.ones((N, N), dtype=np.int32)
indeg = np.zeros((N, N), dtype=np.int32)
for i in range(N):
    for j in range(N):
        c = F[i, j]
        if c == 0:
            continue
        di, dj = doff[c]
        ni, nj = i + di, j + dj
        if 0 <= ni < N and 0 <= nj < N:
            indeg[ni, nj] += 1
q = deque()
for i in range(N):
    for j in range(N):
        if indeg[i, j] == 0:
            q.append((i, j))
while q:
    i, j = q.popleft()
    c = F[i, j]
    if c == 0:
        continue
    di, dj = doff[c]
    ni, nj = i + di, j + dj
    if 0 <= ni < N and 0 <= nj < N:
        acc[ni, nj] += acc[i, j]
        indeg[ni, nj] -= 1
        if indeg[ni, nj] == 0:
            q.append((ni, nj))
print('accumulation %.1fs, max=%d' % (time.time() - t0, acc.max()))

# ---- 4) 阈值提取 + 追踪折线 ----
mask = acc >= THR
# 河网格的下游河网格（用于找源头和追踪）
def dstream(i, j):
    c = F[i, j]
    if c == 0:
        return None
    di, dj = doff[c]
    ni, nj = i + di, j + dj
    if 0 <= ni < N and 0 <= nj < N and mask[ni, nj]:
        return (ni, nj)
    return None

# 源头 = 河网格且无上游河网格汇入
srcs = []
for i in range(N):
    for j in range(N):
        if not mask[i, j]:
            continue
        has_up = False
        for (di, dj), code in D8:
            ui, uj = i - di, j - dj   # 上游方向（反向）
            if 0 <= ui < N and 0 <= uj < N and mask[ui, uj]:
                # 检查该邻居是否真的流入本格
                c2 = F[ui, uj]
                if c2 and (ui + doff[c2][0], uj + doff[c2][1]) == (i, j):
                    has_up = True
                    break
        if not has_up:
            srcs.append((i, j))

# 从每个源头向下游追踪
def to_lonlat(i, j):
    lon = LON_MIN + (j + 0.5) / N * (LON_MAX - LON_MIN)
    lat = LAT_MAX - (i + 0.5) / N * (LAT_MAX - LAT_MIN)
    return [round(lon, 5), round(lat, 5)]

lines = []
seen = set()
for s in srcs:
    path = []
    i, j = s
    while (i, j) not in seen and mask[i, j]:
        seen.add((i, j))
        path.append((i, j))
        d = dstream(i, j)
        if d is None:
            break
        i, j = d
    if len(path) >= MIN_LEN:
        lines.append([len(path), [to_lonlat(a, b) for a, b in path]])

# 汇合点未覆盖的残余河段：从被标记但未追踪的河网格补一段（保证覆盖）
resid = 0
for i in range(N):
    for j in range(N):
        if mask[i, j] and (i, j) not in seen:
            i0, j0 = i, j
            path = []
            while (i, j) not in seen and mask[i, j]:
                seen.add((i, j)); path.append((i, j))
                d = dstream(i, j)
                if d is None: break
                i, j = d
            if len(path) >= MIN_LEN:
                lines.append([len(path), [to_lonlat(a, b) for a, b in path]])
                resid += len(path)

out = {'thr': THR, 'n': N, 'lines': lines}
with open(os.path.join(DATA, 'streams.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
tot = sum(len(l[1]) for l in lines)
print('DONE: %d lines, %d points, %.1fs (resid %d)' % (len(lines), tot, time.time() - t0, resid))
