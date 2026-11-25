/* ═══════════════════════════════════════════════════════════════
   金沙江平台统一色带 · 单一来源（single source of truth）
   -----------------------------------------------------------------
   风险色（高/中/低）、证据/等级色（A/B/C/D）、生态评估等级色（优/良/中/差）
   统一在此定义；三维场景、图表面板、图例共用，杜绝多处硬编码不一致。
   改颜色只改这里，全站同步。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  window.PALETTE = {
    /* 风险三色（沿用现有：高=红、中=橙、低=绿） */
    risk: { high: '#ff5a5a', mid: '#ffb03a', low: '#4ade80' },
    /* 证据 / 综合等级四色（A 优 → 绿，D 差 → 红） */
    grade: { A: '#4ade80', B: '#7fe3cd', C: '#ffb03a', D: '#ff8a8a' },
    /* 生态评估等级四色（优/良/中/差） */
    eco: { good: '#3b6d11', fine: '#0f6e56', mid: '#ef9f27', poor: '#e24b4a' }
  };
  /* 便捷取色 */
  window.riskColOf = function (r) {
    var m = window.PALETTE.risk;
    return r === '高风险' ? m.high : (r === '中风险' ? m.mid : m.low);
  };
  window.gradeColOf = function (g) {
    var m = window.PALETTE.grade;
    return m[g] || '#7fe3cd';
  };
})();
