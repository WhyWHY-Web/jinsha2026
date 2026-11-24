/* ═══════════════════════════════════════════════════════════════════════════
   指标计算 · JavaScript 端实现（与 server.py 的 _m() 逐行同源）
   ───────────────────────────────────────────────────────────────────────────
   为什么要有这个文件
     老师反馈里被点名的"三处同源"问题：页面评分、情景推演、智能体回答如果各算一套，
     同一个站会出现两个数。本文件把后端 _m() 的公式原样搬到前端，只做一件事——算指标。
     它同时被 tools/test_consistency.py 用 Node 加载，做 Python↔JS 跨语言一致性回归，
     任何一边改了公式而另一边没跟上，测试立刻红。
   口径
     输入 lc 六类占比（0–1）、坡度（°）、相对起伏（m）、年降水（mm）、年均温（℃）
     输出与 server.py: _m() 的键完全一致
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node / 测试
  if (root) root.METRICS = api;                                            // 浏览器
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this),
   function () {
  'use strict';

  var VERSION = '1.0.0';

  function m(i) {
    var f = +i.f || 0, g = +i.g || 0, c = +i.c || 0;
    var b = +i.b || 0, ba = +i.ba || 0, w = +i.w || 0, we = +i.we || 0;
    var slope = +i.slope || 0, relief = +i.relief || 0;
    var P = +i.P || 0, T = +i.T || 0;

    var fvc = Math.min(1, f * .92 + g * .62 + c * .55 + we * .75 + ba * .05 + b * .08);
    var carbon = (f * 52 + g * 7.5 + c * 5.2 + we * 18 + ba * .4 + b * 1.2) *
                 (.72 + .28 * Math.min(1.35, Math.max(.45, P / 1200)));
    var slide = 100 * (.42 * Math.min(1, Math.max(0, (slope - 4) / 28)) + .18 * Math.min(1, relief / 800) +
                       .22 * Math.min(1, P / 1600) + .18 * (1 - Math.min(1, f * .8 + g * .35)));
    var dry = Math.min(1, Math.max(0, (T - 6) / 18)) * Math.min(1, Math.max(.15, 1 - P / 1800));
    var deg = 100 * (.4 * (1 - fvc) + .3 * dry + .18 * Math.min(1, b / .10) + .12 * (1 - f));
    var lsi = 100 * (.45 * Math.min(1, Math.max(0, (slope - 5) / 30)) + .30 * Math.min(1, relief / 900) +
                     .15 * Math.min(1, b / .12) + .10 * Math.min(1, ba / .15));
    var abi = 100 * (.35 * f + .21 * g + .28 * (w + we) + .11 * c + .04 * b + .01 * ba);
    var wri = 100 * (.70 * Math.min(1, P / 1600) + .30 * Math.min(1, (w + we) / .05));
    var ei = (.35 * abi + .25 * fvc * 100 + .15 * wri + .15 * (100 - lsi)) / .90;
    var risk = .42 * slide + .33 * deg + .25 * lsi;

    var habitat = Math.min(1, f * .95 + g * .72 + we * .90 + w * .78 + c * .42 + b * .08 + ba * .20);
    var biodiversity = Math.min(1, habitat * (.78 + .22 * f));
    var water = P * (.50 + .42 * f);
    var soil = Math.max(0, Math.min(40, 10 + 40 * f - slope * .20 + g * 5));
    var climate = Math.min(1, .35 + .50 * f + .20 * g);
    var resilience = Math.min(1, Math.max(.08, .30 + .55 * f + .20 * g - .15 * b));
    var esv = Math.max(0, Math.min(4, 1.0 + 3.0 * f + 1.3 * g + .9 * we + .5 * w - .3 * ba));
    var disturbance = Math.min(1, b * 2.8 + c * .45 + ba * .5);
    var eei = (18 * habitat + 15 * biodiversity + 14 * (water / 1000) + 12 * (soil / 40) +
               12 * climate + 11 * resilience + 10 * (esv / 4) + 8 * (1 - disturbance));

    return {
      fvc: fvc, carbon: carbon, slide: slide, deg: deg, lsi: lsi, abi: abi, wri: wri,
      ei: ei, risk: risk, habitat: habitat, biodiversity: biodiversity, water: water,
      soil: soil, climate: climate, resilience: resilience, esv: esv,
      disturbance: disturbance, eei: eei
    };
  }

  function grade(v) { return v >= 75 ? 'A' : v >= 65 ? 'B' : v >= 55 ? 'C' : 'D'; }

  /* 风险分级阈值：与报告正文「58 / 45」一致 */
  function riskLabel(r) { return r >= 58 ? '高风险' : (r >= 45 ? '中风险' : '低风险'); }

  return { VERSION: VERSION, m: m, grade: grade, riskLabel: riskLabel };
});
