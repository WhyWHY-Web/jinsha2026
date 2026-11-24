/* NDVI 趋势专题：每站一根趋势箭头（向上=改善，向下=退化，长度 ∝ 斜率绝对值）
   数据来自 /api/legacy/stations 的 NDVI趋势（Sen 斜率，单位 1/年），
   已在前端站点数组第 23 列。纯视觉专题，不参与指标计算。 */
(function () {
  'use strict';
  var G3 = { group: null, on: true, built: false };
  function q(id) { return document.getElementById(id); }

  function build() {
    if (!window.THREE || !window.scene || !window.pillars || !window.pillars.length) return false;
    if (G3.built) return true;
    var S = window.STATIONS || [];
    var g = new THREE.Group();
    g.name = 'trendArrows';
    var n = 0;
    for (var i = 0; i < S.length; i++) {
      var s = S[i], sen = Number(s[23] || 0);
      if (!isFinite(sen) || Math.abs(sen) < 0.0008) continue;   // 不显著的不画，避免噪声
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
    window.scene.add(g);
    G3.group = g; G3.built = true; G3.count = n;
    return n > 0;
  }

  function chip() {
    var row = document.querySelector('#hudLayers .hud-row');
    if (!row || q('trChip')) return;
    var el = document.createElement('span');
    el.id = 'trChip';
    el.className = 'lchip on';
    el.title = 'NDVI 年值趋势：绿箭头改善 / 红箭头退化，长度表示快慢';
    el.innerHTML = '<i class="dt"></i>植被趋势';
    el.onclick = function () {
      G3.on = !G3.on;
      if (G3.group) G3.group.visible = G3.on;
      el.classList.toggle('on', G3.on);
      window.toast && window.toast(G3.on ? '植被趋势箭头已显示' : '已隐藏', 'ok', '↕');
    };
    row.appendChild(el);
  }

  var tries = 0;
  var t = setInterval(function () {
    tries++;
    if (build()) {
      clearInterval(t);
      chip();
      if (window.toast) window.toast('植被趋势专题：' + G3.count + ' 站有显著趋势', 'ok', '↕');
    } else if (tries > 40) clearInterval(t);
  }, 600);
})();
