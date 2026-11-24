# -*- coding: utf-8 -*-
"""GEE 初始化 + 流域 AOI 加载（供土地利用/夜间灯光/人口/空间分析脚本复用）。"""
import ee
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.path.join(ROOT, 'tools', 'gee-key.json')
BASIN = os.path.join(ROOT, 'data', 'basin', 'jinsha_basin.geojson')
PROJECT = 'jinsha-eco'


def init():
    cred = json.load(open(KEY, encoding='utf-8'))
    ee.Initialize(ee.ServiceAccountCredentials(cred['client_email'], KEY), project=PROJECT)


def load_aoi():
    """返回 (FeatureCollection, 流域几何)，供 reduceRegion/采样使用。"""
    gj = json.load(open(BASIN, encoding='utf-8'))
    feats = [ee.Feature(ee.Geometry(f['geometry'])) for f in gj['features']]
    fc = ee.FeatureCollection(feats)
    return fc, fc.geometry()
