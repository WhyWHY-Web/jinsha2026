# -*- coding: utf-8 -*-
"""
从 NASA POWER（MERRA-2 再分析）拉取各站点 2000–2024 逐年气候序列。

数据源
  https://power.larc.nasa.gov/api/temporal/monthly/point
  免费、无需密钥、可引用（NASA Langley Research Center POWER Project）
参数
  T2M          2 m 气温            ℃（月均）
  PRECTOTCORR  校正后降水          mm/day（月均日速率）
  EVLAND       陆面蒸散            mm/day（月均日速率）

高程订正（重要）
  MERRA-2 是 0.5°×0.625° 格点，格点高程取的是格元平均，山区普遍高于站点
  （本流域实测高 50–1850 m），直接用会把气温系统性压低好几度。
  这里按标准气温直减率 6.5 ℃/km 从格点高程订正到站点高程：
      T_站 = T_格 + 6.5 × (Z_格 − Z_站) / 1000
  降水/蒸散为格元面平均值，未做地形订正（山区会低估地形雨），已在输出里注明。

输出 data/climate.json
  stations[站名].years = [[年, 年均温℃, 年降水mm, 年蒸散mm], ...]
  basin = 流域均值序列（同结构）

用法
  python tools/fetch_climate.py                 # 2000–2024
  python tools/fetch_climate.py --start 1995
  python tools/fetch_climate.py --lapse 0       # 关闭高程订正（看原始格点值）
"""
import calendar, json, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS = os.path.join(ROOT, 'data', 'stations.json')
OUT = os.path.join(ROOT, 'data', 'climate.json')
CACHE = os.path.join(ROOT, 'data', '.power_cache.json')
API = 'https://power.larc.nasa.gov/api/temporal/monthly/point'
PARAMS = 'T2M,PRECTOTCORR,EVLAND'
FILL = -999.0


def fetch(lon, lat, start, end, tries=4):
    q = urllib.parse.urlencode({
        'parameters': PARAMS, 'community': 'AG',
        'longitude': round(lon, 3), 'latitude': round(lat, 3),
        'start': start, 'end': end, 'format': 'JSON'})
    url = API + '?' + q
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'JinshaEco/2.0 (research)'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            last = e
            time.sleep(2 + i * 3)          # 退避：POWER 偶发超时
    raise RuntimeError('取数失败 %s,%s: %s' % (lon, lat, last))


def annualize(param, years):
    """把 YYYYMM 月值聚合成逐年 (温度取均值，降水/蒸散按月天数累加)。"""
    out = {}
    for y in years:
        vals, total = [], 0.0
        ok = True
        for m in range(1, 13):
            v = param.get('%d%02d' % (y, m))
            if v is None or v <= FILL + 1:
                ok = False
                break
            vals.append(v)
            total += v * calendar.monthrange(y, m)[1]
        if not ok or not vals:
            continue
        if param is None:
            continue
        out[y] = (sum(vals) / len(vals), total)
    return out


def main():
    start = 2000
    end = 2024
    lapse = 6.5
    for i, a in enumerate(sys.argv):
        if a == '--start' and i + 1 < len(sys.argv): start = int(sys.argv[i + 1])
        if a == '--end' and i + 1 < len(sys.argv): end = int(sys.argv[i + 1])
        if a == '--lapse' and i + 1 < len(sys.argv): lapse = float(sys.argv[i + 1])
    years = list(range(start, end + 1))

    db = json.load(open(STATIONS, encoding='utf-8'))
    sts = db['stations']
    cache = json.load(open(CACHE, encoding='utf-8')) if os.path.exists(CACHE) else {}
    print('站点 %d 个，年份 %d–%d' % (len(sts), start, end))

    result, basin_acc = {}, {}
    for n, s in enumerate(sts, 1):
        key = '%s_%s' % (s['name'], '%d-%d' % (start, end))
        if key in cache:
            d = cache[key]
        else:
            d = fetch(s['lon'], s['lat'], start, end)
            cache[key] = d
            json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
            time.sleep(1.2)                 # 控制请求频率
        p = d['properties']['parameter']
        gz = float(d['geometry']['coordinates'][2] or 0)
        se = float(s.get('elev') or gz)
        corr = round(lapse * (gz - se) / 1000.0, 2)      # 格点 → 站点高程的气温订正
        t = annualize(p['T2M'], years)
        pr = annualize(p['PRECTOTCORR'], years)
        et = annualize(p['EVLAND'], years)
        rows = []
        for y in years:
            if y in t and y in pr and y in et:
                rows.append([y, round(t[y][0] + corr, 2), round(pr[y][1], 1), round(et[y][1], 1)])
        result[s['name']] = {'lon': s['lon'], 'lat': s['lat'], 'elev': s.get('elev'),
                             'gridElev': round(gz), 'lapseCorr': corr, 'years': rows}
        for y, tt, pp, ee in rows:
            a = basin_acc.setdefault(y, [0.0, 0.0, 0.0, 0])
            a[0] += tt; a[1] += pp; a[2] += ee; a[3] += 1
        print('  %2d/%d %-6s %d 年  均温 %.1f℃  年降水 %.0f mm'
              % (n, len(sts), s['name'], len(rows),
                 sum(r[1] for r in rows) / max(1, len(rows)),
                 sum(r[2] for r in rows) / max(1, len(rows))))

    basin = [[y, round(v[0] / v[3], 2), round(v[1] / v[3], 1), round(v[2] / v[3], 1)]
             for y, v in sorted(basin_acc.items()) if v[3]]

    out = {
        'source': 'NASA POWER · MERRA-2 再分析',
        'api': API,
        'params': {'T2M': '℃', 'PRECTOTCORR': 'mm/day', 'EVLAND': 'mm/day'},
        'note': ('月值聚合为年值：温度取 12 月均值，降水/蒸散按月天数累加为年总量；'
                 '气温已按 %.1f ℃/km 直减率从 MERRA-2 格点高程订正到站点高程，'
                 '降水/蒸散为格元面平均值（山区未做地形雨订正，可能偏低）' % lapse),
        'lapse': lapse,
        'license': 'NASA POWER 开放数据（引用 NASA Langley Research Center）',
        'period': [start, end],
        'fetched': time.strftime('%Y-%m-%d %H:%M'),
        'stations': result,
        'basin': basin,
    }
    json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n写出 %s：%d 站 × %d 年，流域序列 %d 年' % (OUT, len(result), len(years), len(basin)))


if __name__ == '__main__':
    main()
