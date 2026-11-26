/* NDVI 趋势专题：每站一根趋势箭头（向上=改善，向下=退化，长度 ∝ 斜率绝对值）
   数据来自 /api/legacy/stations 的 NDVI趋势（Sen 斜率，单位 1/年），
   已在前端站点数组第 23 列。纯视觉专题，不参与指标计算。 */
(function () {
  'use strict';
  var trendGroup = null;

  function build() {
    if (!window.THREE || !window.scene || !window.pillars || !window.pillars.length) return false;
    var S = window.STATIONS || [];
    var g = new THREE.Group();
    g.name = 'trendArrows';
    var n = 0;
    for (var i = 0; i < S.length; i++) {
      var s = S[i], sen = Number(s[23] || 0);
      if (!Number.isFinite(sen) || Math.abs(sen) < 0.0008 || !/(上升|下降)/.test(String(s[24] || ''))) continue;
      var down = sen < 0;
      var h = 6 + Math.min(26, Math.abs(sen) * 3400);            // 0.008/年 → 约 33
      var w = window.toWorld(s[2], s[3]);
      var y = window.terrainYAt(s[2], s[3]) * window.G.exag;
      var col = down ? 0xff5a5a : 0x4ade80;
      var cone = new THREE.Mesh(
        new THREE.ConeGeometry(1.5, h * 0.34, 8),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false }));
      var shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, h * 0.72, 6),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false }));
      var base = y + 12;                                          // 站点柱上方
      if (down) {
        cone.position.set(w.x, base - h * 0.17, w.z); cone.rotation.z = Math.PI;
        shaft.position.set(w.x, base + h * 0.36 - h * 0.72 + h * 0.36, w.z);
      } else {
        cone.position.set(w.x, base + h * 0.83, w.z);
        shaft.position.set(w.x, base + h * 0.36, w.z);
      }
      cone.userData = shaft.userData = { st: s, sen: sen };
      g.add(cone); g.add(shaft);
      n++;
    }
    g.visible = Boolean(window.G.layers.ndviTrend);
    if (trendGroup) {
      window.scene.remove(trendGroup);
      trendGroup.traverse(function (obj) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }
    trendGroup = g;
    window.scene.add(g);
    return n;
  }

  window.JinshaTrendArrows = {
    rebuild: build,
    setVisible: function (visible) {
      window.G.layers.ndviTrend = Boolean(visible);
      if (trendGroup) trendGroup.visible = Boolean(visible);
      else if (visible) build();
    },
    isVisible: function () {
      return Boolean(window.G && window.G.layers.ndviTrend);
    }
  };
  if (window.scene) build();
})();
