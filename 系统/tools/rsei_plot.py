# -*- coding: utf-8 -*-
"""RSEI 论文图表：读 data/rsei/*.json 与 moran_lisa.json，生成论文级 PNG
图1 RSEI 均值时序   图2 分级面积占比堆叠   图3 四分量时序   图4 Moran's I 时序
用法：python tools/rsei_plot.py
"""
import json, os, glob
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'rsei')
FIG = os.path.join(OUT, 'figures')
os.makedirs(FIG, exist_ok=True)

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei']
plt.rcParams['axes.unicode_minus'] = False
plt.rcParams['figure.dpi'] = 150

CLASS_COLORS = ['#d73027', '#fc8d59', '#fee08b', '#a6d96a', '#1a9850']
CLASS_LABELS = ['差', '较差', '中等', '良', '优']

def load_years():
    years = []
    for f in sorted(glob.glob(os.path.join(OUT, 'rsei_*.json'))):
        base = os.path.basename(f)
        if base.startswith('rsei_') and base != 'rsei_all.json':
            with open(f, encoding='utf-8') as fp:
                d = json.load(fp)
            if 'error' not in d:
                years.append(d)
    years.sort(key=lambda d: d['year'])
    return years

def load_moran():
    p = os.path.join(OUT, 'moran_lisa.json')
    if os.path.exists(p):
        with open(p, encoding='utf-8') as fp:
            return json.load(fp)
    return {}

def plot_timeseries(years):
    xs = [d['year'] for d in years]
    ys = [d['rsei_mean'] for d in years]
    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.plot(xs, ys, 'o-', color='#2c7fb8', lw=2, ms=7)
    for x, y in zip(xs, ys):
        ax.annotate('%.3f' % y, (x, y), textcoords='offset points', xytext=(0, 8), ha='center', fontsize=9)
    ax.set_xlabel('年份'); ax.set_ylabel('RSEI 均值')
    ax.set_title('金沙江流域 RSEI 时序变化（1990-2025）')
    ax.grid(alpha=0.3); ax.set_ylim(min(ys) - 0.06, max(ys) + 0.06)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, 'fig1_rsei时序.png')); plt.close(fig)

def plot_class_stack(years):
    xs = [d['year'] for d in years]
    data = [[d['class_%d_pct' % k] for d in years] for k in range(5)]
    fig, ax = plt.subplots(figsize=(7, 4.2))
    bottom = [0] * len(xs)
    for k in range(5):
        ax.bar(xs, data[k], bottom=bottom, color=CLASS_COLORS[k], label=CLASS_LABELS[k], width=3)
        bottom = [b + v for b, v in zip(bottom, data[k])]
    ax.set_xlabel('年份'); ax.set_ylabel('面积占比（%）')
    ax.set_title('RSEI 各等级面积占比变化')
    ax.legend(ncol=5, fontsize=8, loc='upper center', bbox_to_anchor=(0.5, -0.12))
    ax.set_ylim(0, 100)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, 'fig2_分级占比.png'), bbox_inches='tight'); plt.close(fig)

def plot_components(years):
    xs = [d['year'] for d in years]
    comps = [('ndvi_mean', 'NDVI 绿度', '#2ca25f'), ('wet_mean', 'WET 湿度', '#3182bd'),
             ('ndsi_mean', 'NDSI 干度', '#de2d26'), ('lst_mean', 'LST 热度', '#fd8d3c')]
    fig, ax = plt.subplots(figsize=(7, 4.2))
    for key, label, color in comps:
        ys = [d[key] for d in years]
        ax.plot(xs, ys, 'o-', label=label, color=color, lw=1.8, ms=5)
    ax.set_xlabel('年份'); ax.set_ylabel('归一化均值')
    ax.set_title('RSEI 四分量归一化均值时序')
    ax.legend(fontsize=9); ax.grid(alpha=0.3)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, 'fig3_四分量.png')); plt.close(fig)

def plot_moran(moran):
    if not moran:
        print('无 moran_lisa.json，跳过图4'); return
    items = sorted([(int(k), v) for k, v in moran.items() if 'moran_I' in v])
    if not items:
        print('moran 数据不足，跳过图4'); return
    xs = [k for k, v in items]; ys = [v['moran_I'] for k, v in items]
    fig, ax = plt.subplots(figsize=(7, 4.2))
    ax.plot(xs, ys, 'o-', color='#756bb1', lw=2, ms=7)
    for x, y in zip(xs, ys):
        ax.annotate('%.3f' % y, (x, y), textcoords='offset points', xytext=(0, 8), ha='center', fontsize=9)
    ax.set_xlabel('年份'); ax.set_ylabel("Moran's I")
    ax.set_title("RSEI 空间自相关 Moran's I 时序")
    ax.grid(alpha=0.3)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, 'fig4_moran.png')); plt.close(fig)

def main():
    years = load_years()
    print('已加载 %d 期 RSEI: %s' % (len(years), [d['year'] for d in years]))
    if len(years) < 2:
        print('期次不足，跳过绘图'); return
    plot_timeseries(years)
    plot_class_stack(years)
    plot_components(years)
    plot_moran(load_moran())
    print('图表已生成到:', FIG)
    for f in sorted(os.listdir(FIG)):
        print('  ', f)

if __name__ == '__main__':
    main()
