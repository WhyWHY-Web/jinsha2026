(() => {
  "use strict";

  const metricConfig = {
    rsei: { name: "遥感生态 RSEI", color: "#35e0b8", colors: ["#784b64", "#d1a077", "#45b99d", "#64efd4"] },
    gcpi: { name: "贫困指数 GCPI", color: "#edb278", colors: ["#4bbfa5", "#8bbbab", "#edb278", "#e66670"] },
    ltccd: { name: "协调度 LTCCD", color: "#63c8fd", colors: ["#855070", "#e2977c", "#559bcc", "#5cdbba"] },
    lisa: { name: "空间聚类 LISA", palette: { HH: "#ef747c", HL: "#f8bb75", LH: "#60cce6", LL: "#7c88d8", NS: "#516780" } },
  };
  const colors = {
    text: "#d8f1f8", mute: "#8fa9bc", line: "rgba(94,158,186,.23)", bg: "#0d1b2c",
  };
  const layout = [
    '<div class="coupling-tools"><div class="coupling-modes" role="group" aria-label="空间图层"></div>',
    '<label>观测年份 <select aria-label="观测年份"></select></label></div>',
    '<div class="coupling-status" role="status"></div>',
    '<div class="coupling-content" hidden>',
    '  <div class="coupling-stats"></div>',
    '  <div class="coupling-charts">',
    '    <section><div class="coupling-head"><div><h3>空间分布</h3><p class="coupling-map-meta"></p></div><button type="button" class="coupling-reset">复位地图</button></div>',
    '      <div class="coupling-map" role="img" aria-label="金沙江流域空间分布图"></div></section>',
    '    <section><div class="coupling-head"><div><h3>多期指数趋势</h3><p>无量纲。点击观测点选择年份。</p></div></div>',
    '      <div class="coupling-trend" role="img" aria-label="RSEI、GCPI 和 LTCCD 时序"></div>',
    '      <div class="coupling-test"></div></section>',
    '  </div>',
    '  <div class="coupling-detail">',
    '    <section><div class="coupling-head"><div><h3>站点演示估计</h3><p>RSEI、GCPI、LTCCD 均为 0–1</p></div></div><div class="coupling-stations"></div></section>',
    '    <section><div class="coupling-head"><div><h3>方法与数据</h3><p>沿流域采样归档、台账与站点代理估计</p></div></div>',
    '      <div class="coupling-method"></div></section>',
    '  </div>',
    '</div>',
  ].join("");

  const css = [
    '#jrCoupling{--cp-bg:#0c1929;--cp-panel:#101f33;--cp-text:#d8f1f8;--cp-muted:#92aec1;--cp-line:#203d52;--cp-accent:#73e5d8;width:100%;padding:5px 7px 16px;line-height:1.45;color:var(--cp-text)}',
    '#jrCoupling [hidden]{display:none!important} #jrCoupling h3{font-size:14px;margin:0;color:var(--cp-text)} #jrCoupling p{margin:3px 0 0;color:var(--cp-muted);font-size:11px}',
    '#jrCoupling .coupling-tools,#jrCoupling .coupling-head{display:flex;justify-content:space-between;align-items:center;gap:10px}',
    '#jrCoupling .coupling-tools{padding:2px 2px 8px;flex-wrap:wrap} #jrCoupling .coupling-modes{display:flex;flex-wrap:wrap;gap:6px}',
    '#jrCoupling label{font-size:12px;color:var(--cp-muted);display:flex;align-items:center;gap:7px}',
    '#jrCoupling button,#jrCoupling select{cursor:pointer;border:1px solid #28506b;border-radius:5px;color:var(--cp-text);font-family:inherit;font-size:12px;line-height:1.2;font-weight:500;padding:6px 9px;background:#12243a}',
    '#jrCoupling button[aria-pressed=true]{border-color:#35bbae;color:#a9fff2;background:#15383e} #jrCoupling button:hover{border-color:var(--cp-accent)}',
    '#jrCoupling .coupling-status{padding:5px 2px 10px;color:var(--cp-muted);font-size:11px;min-height:28px} #jrCoupling .coupling-status button{margin-left:8px}',
    '#jrCoupling .coupling-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0 0 9px}',
    '#jrCoupling .coupling-stat,#jrCoupling section{border:1px solid var(--cp-line);background:linear-gradient(155deg,#112238,#0d1929);border-radius:7px}',
    '#jrCoupling .coupling-stat{min-width:0;padding:8px 10px;color:var(--cp-muted);font-size:11px} #jrCoupling .coupling-stat b{display:block;margin:1px 0;color:#a9f5ea;font:600 21px/1.22 system-ui;font-variant-numeric:tabular-nums}',
    '#jrCoupling .coupling-stat span{display:block} #jrCoupling .coupling-charts,#jrCoupling .coupling-detail{display:grid;gap:9px}',
    '#jrCoupling .coupling-charts{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)} #jrCoupling .coupling-detail{grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-top:9px}',
    '#jrCoupling section{min-width:0;overflow:hidden} #jrCoupling .coupling-head{padding:9px 11px 3px} #jrCoupling .coupling-map{height:340px} #jrCoupling .coupling-trend{height:255px}',
    '#jrCoupling .coupling-test,#jrCoupling .coupling-method,#jrCoupling .coupling-stations{padding:5px 11px 10px}',
    '#jrCoupling .coupling-test{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px} #jrCoupling .coupling-test div{padding:4px 7px;border-left:1px solid var(--cp-line);min-width:0}',
    '#jrCoupling .coupling-test strong,#jrCoupling .coupling-method strong{font-size:11px;color:var(--cp-text)}',
    '#jrCoupling .coupling-stations .coupling-station-status{min-height:24px;color:#97dddb} #jrCoupling .coupling-table{overflow:auto;max-height:235px}',
    '#jrCoupling table{border-collapse:collapse;width:100%;font-size:11px;font-variant-numeric:tabular-nums} #jrCoupling td,#jrCoupling th{text-align:left;border-bottom:1px solid #20394e;padding:3px 6px;white-space:nowrap}',
    '#jrCoupling thead{position:sticky;top:0;background:#122339;color:var(--cp-muted)} #jrCoupling td button{padding:4px 6px;font-size:11px}',
    '#jrCoupling tr.selected{background:#142f44} #jrCoupling .coupling-method p{margin:3px 0 7px;line-height:1.52} #jrCoupling .coupling-method dl{margin:4px 0}',
    '@media(max-width:900px){#jrCoupling .coupling-charts,#jrCoupling .coupling-detail{grid-template-columns:minmax(0,1fr)} #jrCoupling .coupling-stats{grid-template-columns:repeat(3,minmax(0,1fr))} #jrCoupling .coupling-map{height:310px}}',
    '@media(max-width:460px){#jrCoupling .coupling-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  ].join("\n");

  const state = { root: null, year: null, mode: "rsei", report: null, selected: "", request: 0 };
  const query = (selector) => state.root.querySelector(selector);
  const format = (value, digits = 3) => value == null ? "—" : Number(value).toFixed(digits);
  const signed = (value) => value == null ? "—" : Number(value).toExponential(2);
  const element = (tag, value) => Object.assign(document.createElement(tag), { textContent: value });

  function status(message, retry = false) {
    const box = query(".coupling-status");
    box.replaceChildren(document.createTextNode(message));
    if (retry) {
      const button = element("button", "重试");
      button.type = "button";
      button.addEventListener("click", () => request(state.year));
      box.append(button);
    }
  }

  function stat(name, value, detail) {
    const box = element("div", name);
    box.className = "coupling-stat";
    box.append(element("b", value), element("span", detail));
    return box;
  }

  function panels(report) {
    const record = report.series.find(row => row.year === report.year);
    const label = (value) => value == null ? "当期缺少同年输入" : report.coverage.demo_stations + " 个站点均值 · 演示";
    query(".coupling-stats").replaceChildren(
      stat("流域 RSEI", format(record.rsei), record.year + " 年 · 有效像元均值"),
      stat("GCPI", format(record.gcpi), label(record.gcpi)),
      stat("LTCCD", format(record.ltccd), label(record.ltccd)),
      stat("Moran’s I · RSEI", format(record.moran_rsei), "Queen 邻接 · p " + format(record.moran_rsei_p)),
      stat("Theil T · LTCCD", format(record.theil), record.theil == null ? "当期无站点估计" : "站点差异 · IDW Moran’s I " + format(record.moran_ltccd)),
    );

    const tests = Object.entries(report.statistics).map(([metric, test]) => {
      const box = element("div", "");
      box.append(element("strong", metric.toUpperCase() + " · " + test.n + " 期"),
        element("p", "Sen " + signed(test.sen) + " /年"),
        element("p", "MK p " + format(test.p) + " · τ " + format(test.tau)));
      return box;
    });
    query(".coupling-test").replaceChildren(...tests);
    const sources = [["rsei", "遥感生态"], ["lisa", "空间统计"], ["gcpi", "GCPI · 演示"], ["ltccd", "LTCCD · 演示"], ["trend", "趋势与比较"]];
    const descriptions = sources.flatMap(([key, title]) => [element("strong", title), element("p", report.sources[key])]);
    if (Object.keys(report.pca_weights).length) {
      descriptions.push(element("strong", "GCPI · 合并站点年 PCA 权重"));
      descriptions.push(element("p", Object.entries(report.pca_weights).map(([key, value]) =>
        ({ slope: "坡度", hsi: "HSI", pd: "人口密度", pcd: "可达性" })[key] + " " +
        (value * 100).toFixed(1) + "%").join(" · ")));
    }
    query(".coupling-method").replaceChildren(...descriptions);
  }

  function renderStationDetails() {
    const box = query(".coupling-stations");
    const rows = state.report.stations;
    if (!rows.length) {
      box.replaceChildren(element("p", "当前年份有遥感归档，尚无计算 GCPI 与 LTCCD 所需的同年站点输入。"));
      return;
    }
    const status = element("p", "点选站点查看等级、坡度和代理指标。");
    status.className = "coupling-station-status";
    const scroller = element("div", "");
    scroller.className = "coupling-table";
    const table = element("table", "");
    const head = table.createTHead().insertRow();
    ["站点", "RSEI", "GCPI", "LTCCD", "协调分级"].forEach(name => head.append(element("th", name)));
    const body = table.createTBody();
    const sorted = rows.slice().sort((a, b) => a.ltccd - b.ltccd);
    sorted.forEach(station => {
      const row = body.insertRow();
      row.dataset.station = station.name;
      const button = element("button", station.name);
      button.type = "button";
      button.addEventListener("click", () => {
        state.selected = station.name;
        if (state.mode === "rsei" || state.mode === "lisa") setMode("ltccd");
        else renderMap();
        updateSelection();
      });
      row.insertCell().append(button);
      [format(station.rsei), format(station.gcpi), format(station.ltccd), station.ltccd_grade]
        .forEach(value => row.insertCell().textContent = value);
    });
    scroller.append(table);
    box.replaceChildren(status, scroller);
    updateSelection();
  }

  function updateSelection() {
    const station = state.report.stations.find(row => row.name === state.selected);
    if (!station) return;
    const text = query(".coupling-station-status");
    text.textContent = station.name + " · 坡度 " + format(station.slope, 1) + "° · HSI " +
      format(station.hsi) + " · 人口密度代理 " + format(station.pd, 2) + " 人/km² · 可达性代理 " +
      format(station.pcd) + " · LTCCD " + station.ltccd_grade;
    query(".coupling-table").querySelectorAll("tbody tr").forEach(row => {
      const selected = row.dataset.station === station.name;
      row.classList.toggle("selected", selected);
      row.querySelector("button").setAttribute("aria-pressed", String(selected));
    });
  }

  function renderMap() {
    const report = state.report;
    const mode = state.mode;
    const cfg = metricConfig[mode];
    const stations = mode === "gcpi" || mode === "ltccd";
    const data = stations
      ? report.stations.map(row => ({ name: row.name, value: [row.lon, row.lat, row[mode]],
        symbolSize: row.name === state.selected ? 15 : 9,
        itemStyle: { borderColor: row.name === state.selected ? "#fff2c5" : "#bbcbd4", borderWidth: row.name === state.selected ? 2.5 : 0.7 } }))
      : report.lisa;
    query(".coupling-map-meta").textContent = stations
      ? report.year + " 年 · 站点代理估计 · " + data.length + " 站 · 无量纲"
      : report.year + " 年 · RSEI 归档样点 · " + data.length + " 点" + (mode === "rsei" ? " · 无量纲" : " · Queen 邻接");
    const chart = state.mapChart;
    if (!chart) return;
    const visualMap = mode === "lisa"
      ? { type: "piecewise", dimension: 3, pieces: Object.entries(cfg.palette).map(([value, color]) => ({
        value, color, label: value === "NS" ? "NS 非显著" : value,
      })) }
      : { type: "continuous", min: 0, max: 1, precision: 2, dimension: 2, inRange: { color: cfg.colors },
        calculable: true, text: ["1", "0"] };
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      tooltip: { renderMode: "richText", confine: true, trigger: "item",
        formatter: item => (item.name || "RSEI 样点") + "\n" + cfg.name + " " +
          (mode === "lisa" ? item.value[3] : format(item.value[2])) },
      visualMap: { ...visualMap, left: 9, bottom: 8, textStyle: { color: colors.mute },
        itemHeight: mode === "lisa" ? 11 : 70, itemWidth: 12, seriesIndex: 0 },
      geo: { map: "jinsha-coupling-local", roam: true, zoom: 1, scaleLimit: { min: 0.75, max: 15 },
        layoutCenter: ["55%", "51%"], layoutSize: "97%", silent: true,
        itemStyle: { areaColor: "#163047", borderColor: "#315a70", borderWidth: .45 },
        emphasis: { disabled: true } },
      graphic: !data.length ? [{ type: "text", left: "center", top: "middle", z: 100,
        style: { text: "本年无该图层数据", fill: colors.mute, backgroundColor: colors.bg,
          padding: 9, borderRadius: 4, fontSize: 12 } }] : [],
      series: [{ name: cfg.name, type: "scatter", coordinateSystem: "geo", symbolSize: stations ? 9 : 3,
        progressive: 1000, data, itemStyle: { opacity: stations ? 1 : .78 },
        emphasis: { focus: "self" } }],
    }, { notMerge: true });
  }

  function renderTrend() {
    const report = state.report;
    const chart = state.trendChart;
    if (!chart) return;
    const fields = ["rsei", "gcpi", "ltccd"];
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      color: fields.map(metric => metricConfig[metric].color),
      textStyle: { color: colors.text },
      grid: { left: 40, right: 13, top: 31, bottom: 27 },
      legend: { textStyle: { color: colors.mute }, data: fields.map(metric => metric.toUpperCase()), top: 2 },
      tooltip: { trigger: "axis", renderMode: "richText", confine: true, valueFormatter: value => format(value) },
      xAxis: { type: "category", data: report.years.map(String),
        axisLine: { lineStyle: { color: colors.line } }, axisLabel: { color: colors.mute } },
      yAxis: { min: 0, max: 1, axisLabel: { color: colors.mute }, splitLine: { lineStyle: { color: colors.line } } },
      series: fields.map((metric, index) => ({
        name: metric.toUpperCase(), type: "line", symbolSize: 7, showSymbol: true,
        data: report.series.map(row => row[metric]), connectNulls: false,
        lineStyle: { width: 2, type: index ? "dashed" : "solid" },
        markLine: index ? undefined : { silent: true, symbol: "none", label: { show: false },
          lineStyle: { color: "#73e5d8", opacity: .65 },
          data: [{ xAxis: String(report.year) }] },
      })),
    }, { notMerge: true });
  }

  function render() {
    const report = state.report;
    query(".coupling-content").hidden = false;
    const year = query("select");
    year.replaceChildren(...report.years.map(candidate => Object.assign(element("option", candidate + " 年"), { value: candidate })));
    year.value = report.year;
    if (!state.mapChart && window.echarts && report.boundary.features.length) {
      window.echarts.registerMap("jinsha-coupling-local", report.boundary);
      state.mapChart = window.echarts.init(query(".coupling-map"), "dark", { renderer: "canvas" });
      state.mapChart.on("click", value => {
        if (!["gcpi", "ltccd"].includes(state.mode) || !value.name) return;
        state.selected = value.name;
        state.mapChart.dispatchAction({ type: "highlight", seriesIndex: 0, name: value.name });
        updateSelection();
      });
    }
    if (!state.trendChart && window.echarts) {
      state.trendChart = window.echarts.init(query(".coupling-trend"), "dark", { renderer: "canvas" });
      state.trendChart.on("click", value => {
        if (value.seriesType === "line" && Number(value.name) !== state.year) request(Number(value.name));
      });
    }
    if (!state.mapChart) query(".coupling-map").textContent = "流域边界或地图组件不可用。";
    panels(report);
    renderMap();
    renderTrend();
    renderStationDetails();
  }

  function setMode(mode) {
    state.mode = mode;
    query(".coupling-modes").querySelectorAll("button").forEach(button =>
      button.setAttribute("aria-pressed", String(button.dataset.metric === mode)));
    if (state.report) renderMap();
  }

  async function request(year) {
    const sequence = ++state.request;
    const root = state.root;
    status(year ? "正在载入 " + year + " 年数据…" : "正在载入流域资料…");
    try {
      const response = await fetch("/api/coupling" + (year ? "?year=" + encodeURIComponent(year) : ""));
      if (!response.ok) throw new Error(String(response.status));
      const report = await response.json();
      if (sequence !== state.request || root !== state.root || !root.isConnected) return;
      if (!report.ok || !report.series.length) {
        status("现有数据目录暂时没有可用的 RSEI 归档。");
        return;
      }
      state.report = report;
      state.year = report.year;
      state.selected = "";
      status("RSEI 使用本地遥感归档。GCPI 与 LTCCD 使用站点代理，演示期为 " +
        (report.coupling_years.join("、") || "暂无") + " 年。");
      render();
    } catch (error) {
      if (sequence === state.request && root === state.root && root.isConnected) {
        status("无法载入耦合协调数据。", true);
        if (state.report) query("select").value = state.year;
      }
    }
  }

  function mount() {
    const root = document.getElementById("jrCoupling");
    if (!root || state.root === root) return;
    [state.mapChart, state.trendChart].forEach(chart => { if (chart) chart.dispose(); });
    if (state.resize) state.resize.disconnect();
    if (!document.getElementById("jrCouplingStyle")) {
      const style = element("style", css);
      style.id = "jrCouplingStyle";
      document.head.append(style);
    }
    Object.assign(state, { root, mapChart: null, trendChart: null, report: null });
    root.innerHTML = layout;
    const tabs = query(".coupling-modes");
    Object.entries(metricConfig).forEach(([metric, options]) => {
      const button = element("button", options.name);
      button.type = "button";
      button.dataset.metric = metric;
      button.addEventListener("click", () => setMode(metric));
      tabs.append(button);
    });
    setMode(state.mode);
    query("select").addEventListener("change", (event) => request(Number(event.target.value)));
    query(".coupling-reset").addEventListener("click", () => { if (state.report) renderMap(); });
    if ("ResizeObserver" in window) {
      state.resize = new ResizeObserver(() =>
        [state.mapChart, state.trendChart].forEach(chart => { if (chart && !chart.isDisposed()) chart.resize(); }));
      state.resize.observe(root);
    }
    request(state.year);
  }

  window.JinshaCoupling = { mount };
})();
