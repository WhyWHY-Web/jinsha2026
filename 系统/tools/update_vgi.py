# -*- coding: utf-8 -*-
"""用可见光绿度指数 GLI 重新计算站点影像绿度（真实像元）"""
import json, io, math, os, time, urllib.request
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, 'data', 'stations.json')
UA = {'User-Agent': 'Mozilla/5.0 (research; jinsha-digital-twin)'}
d = json.load(open(P, encoding='utf-8'))

for s in d['stations']:
    lon, lat = s['lon'], s['lat']
    dy, dx = 6 / 111.0, 6 / (111.0 * math.cos(math.radians(lat)))
    url = ('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'
           '?bbox=%.5f,%.5f,%.5f,%.5f&bboxSR=4326&imageSR=4326&size=360,360&format=jpg&f=image'
           % (lon - dx, lat - dy, lon + dx, lat + dy))
    for k in range(3):
        try:
            raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45).read()
            a = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB')).astype(np.float64)
            R, G, B = a[..., 0], a[..., 1], a[..., 2]
            br = (R + G + B) / 3
            m = (br > 15) & (br < 250)
            gli = ((2 * G - R - B) / (2 * G + R + B + 1e-6))[m]
            veg = ((G > R * 1.02) & (G > B * 1.02) & (br > 18))[m]
            s['vgi'] = round(float(gli.mean()), 4)
            s['greenFrac'] = round(float(veg.mean()), 4)
            s['vgiSrc'] = 'World Imagery 可见光绿度 GLI · 6 km 窗'
            print('%-4s GLI %.3f  植被像元 %.0f%%' % (s['name'], s['vgi'], s['greenFrac'] * 100))
            break
        except Exception as e:
            if k == 2: print('!', s['name'], e)
            time.sleep(1.5)

json.dump(d, open(P, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('done')
