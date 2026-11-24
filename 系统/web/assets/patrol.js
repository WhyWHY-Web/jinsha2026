/* 巡检建议报告（真实数据驱动，非演示记录）
   排序依据：综合风险 0.55 + NDVI 年值 Sen 斜率 0.28 + 待复核异常 0.17
   数据指纹变化即自动刷新（20s 轮询 /api/data/version） */
(function () {
  'use strict';
  var P = { token: null, timer: null, last: null };
  function q(id) { return document.getElementById(id); }
  function E(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  var CSS = ''
    + '#ptRpt .pt-hd{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}'
    + '#ptRpt .pt-hd b{font-size:13px;color:#e6f6f4}'
    + '#ptRpt .pt-hd span{font-size:9px;color:#5f7a80;letter-spacing:1px}'
    + '#ptRpt .pt-sum{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}'
    + '#ptRpt .pt-sum i{font-style:normal;font-size:9.5px;padding:2px 7px;border-radius:9px;'
    + 'font-family:Consolas,monospace;background:rgba(53,224,184,.1);border:1px solid rgba(53,224,184,.3);color:#7fe3cd}'
    + '#ptRpt .pt-row{display:flex;gap:8px;padding:8px 9px;margin-bottom:5px;border-radius:6px;'
    + 'background:rgba(13,30,38,.7);border-left:3px solid var(--lv,#4ade80);cursor:pointer;transition:.15s}'
    + '#ptRpt .pt-row:hover{background:rgba(24,52,62,.92)}'
    + '#ptRpt .pt-rk{flex:0 0 26px;text-align:center;font-family:Consolas,monospace;font-size:15px;'
    + 'font-weight:700;color:var(--lv,#4ade80);line-height:1.1}'
    + '#ptRpt .pt-rk small{display:block;font-size:8px;font-weight:400;color:#5f7a80;letter-spacing:0}'
    + '#ptRpt .pt-bd{flex:1;min-width:0}'
    + '#ptRpt .pt-nm{font-size:12px;color:#eafaf6;display:flex;align-items:baseline;gap:6px}'
    + '#ptRpt .pt-nm em{font-style:normal;font-size:9px;color:#7d979b}'
    + '#ptRpt .pt-nm b{margin-left:auto;font-family:Consolas,monospace;font-size:11px;color:var(--lv)}'
    + '#ptRpt .pt-why{font-size:9px;color:#8fb0b5;line-height:1.75;margin-top:3px}'
    + '#ptRpt .pt-why s{text-decoration:none;color:#ffb0b0}'
    + '#ptRpt .pt-meta{font-size:9px;color:#6f8f96;margin-top:2px;font-family:Consolas,monospace}'
    + '#ptRpt .pt-foot{font-size:8.5px;color:#5f7a80;line-height:1.7;margin-top:8px;'
    + 'border-top:1px dashed rgba(255,255,255,.09);padding-top:7px}'
    + '#ptRpt .pt-btn{display:flex;gap:6px;margin:8px 0}'
    + '#ptRpt .pt-btn button{flex:1;font-size:10.5px;padding:5px 0;border-radius:5px;cursor:pointer;'
    + 'border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);color:#b9d6d0}'
    + '#ptRpt .pt-btn button:hover{border-color:#37d9a0;color:#fff}';
  (function () { var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); })();

  function lvColor(l) { return l === '高' ? '#ff5a5a' : (l === '中' ? '#ffb03a' : '#4ade80'); }

  function render(d) {
    var B = q('phBody');
    if (!B) return;
    var h = '<div id="ptRpt">';
    h += '<div class="pt-hd"><b>本周巡检建议</b><span>PATROL ADVISORY</span></div>';
    h += '<div class="pt-sum"><i>站点 ' + d.total + '</i><i>高风险 ' + d.watch.length + '</i>'
      + '<i>生成 ' + E((d.generated || '').slice(11)) + '</i><i>#' + E(d.dataToken) + '</i></div>';
    h += '<div class="mod-note" style="font-size:9.5px;margin-bottom:8px">'
      + '排序 = 综合风险 <b>0.55</b> + NDVI 趋势 <b>0.28</b> + 待复核异常 <b>0.17</b>；'
      + '全部由库内真实指标算出，<b>不含人工填写的巡检状态</b>。</div>';
    h += d.items.map(function (it) {
      var c = lvColor(it.level);
      return '<div class="pt-row" data-n="' + E(it.name) + '" style="--lv:' + c + '">'
        + '<div class="pt-rk">' + it.rank + '<small>' + it.level + '</small></div>'
        + '<div class="pt-bd"><div class="pt-nm">' + E(it.name)
        + '<em>' + E(it.zone) + '</em><b>' + it.score.toFixed(3) + '</b></div>'
        + '<div class="pt-why">' + it.reasons.map(function (r) {
            var bad = /下降|待复核|高/.test(r);
            return bad ? '<s>' + E(r) + '</s>' : E(r);
          }).join('　·　') + '</div>'
        + '<div class="pt-meta">R ' + it.risk + ' ｜ 滑坡 ' + it.slide + ' ｜ 覆盖 '
        + Math.round(it.fvc * 100) + '% ｜ NDVI ' + (it.ndviSen > 0 ? '+' : '') + it.ndviSen + '/年</div>'
        + '</div></div>';
    }).join('');
    h += '<div class="pt-btn"><button id="ptFly">✈ 飞到第一个建议点</button>'
      + '<button id="ptGo">🗂 去区域治理</button></div>';
    h += '<div class="pt-foot">' + E(d.note) + '<br>'
      + '数据指纹 <b>' + E(d.dataToken) + '</b>，变化时自动刷新；'
      + '生成时间 ' + E(d.generated) + '</div></div>';
    B.innerHTML = h;

    B.querySelectorAll('.pt-row').forEach(function (el) {
      el.onclick = function () {
        var nm = el.dataset.n, S = window.STATIONS || [];
        for (var i = 0; i < S.length; i++) {
          if (S[i][0] === nm && window.flyToStationIdx) { window.flyToStationIdx(i); return; }
        }
      };
    });
    var f = q('ptFly');
    if (f) f.onclick = function () {
      var it = d.items[0]; if (!it) return;
      var S = window.STATIONS || [];
      for (var i = 0; i < S.length; i++) if (S[i][0] === it.name) { window.flyToStationIdx(i); return; }
    };
    var g = q('ptGo');
    if (g) g.onclick = function () { if (window.switchModule) window.switchModule('region'); };
  }

  window.patrolRender = function () {
    var B = q('phBody');
    if (B) B.innerHTML = '<div class="mod-note">正在按真实指标生成巡检建议…</div>';
    window.dhFetch('/api/patrol/plan?top=8', 9000).then(function (d) {
      if (!d || !d.ok) throw new Error('接口返回异常');
      P.token = d.dataToken; P.last = d;
      render(d);
    }).catch(function (e) {
      if (B) B.innerHTML = '<div class="mod-note">生成失败：' + E(e.message || e) + '<br>'
        + '确认后端服务在运行后重进本页。</div>';
    });
  };

  /* 指纹轮询：数据一变，报表自动重算 */
  setInterval(function () {
    if (!window.G || window.G.curPh !== 'patrol') return;
    window.dhFetch('/api/data/version', 6000).then(function (j) {
      if (j && j.ok && P.token && j.token !== P.token) {
        window.toast && window.toast('数据已更新，巡检建议已重算', 'ok', '⟳');
        window.patrolRender();
      }
    }).catch(function () {});
  }, 20000);
})();
