# 公开版卫星底图

公开发布使用 NASA EOSDIS GIBS 的 Blue Marble Shaded Relief and Bathymetry。`blue-marble.webp` 是西边界 97.6°E、南界 25.9°N、东界 105.4°E、北界 32.5°N 的 2048 × 1960 像素 Web Mercator WMS 导出。图像边缘渐隐，与区域晕渲衔接。地图以格网高程拉起地形，影像为 NASA Blue Marble 2004 年 8 月合成。 [NASA GIBS](https://www.earthdata.nasa.gov/data/tools/gibs) · [NASA Visible Earth Blue Marble](https://visibleearth.nasa.gov/collection/1484/blue-marble) · [图像使用政策](https://visibleearth.nasa.gov/image-use-policy)

源文件可从 [NASA GIBS WMS 导出接口](https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?service=WMS&request=GetMap&version=1.1.1&layers=BlueMarble_ShadedRelief_Bathymetry&srs=EPSG%3A3857&bbox=10864782.3014235%2C2986700.7776249796%2C11733074.329611035%2C3829123.837028439&width=2048&height=1960&format=image%2Fjpeg) 复取。在工作台目录运行 `python scripts/prepare_public_map.py` 重新生成渐隐影像。公开归档中同时保留 NASA、USGS、Mapzen 和 HydroSHEDS 署名。
