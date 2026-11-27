import { EcologyInputError, evaluateEcology, ecologyOptions } from "./ecology.js";
import { WorkflowError } from "./snapshot-io.js";

import { readScientificSummary } from "./scientific.js";











const intents = new Set        (["assess", "locate", "evidence", "soil", "amend", "help"]);
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

async function interpret(prompt        , stations           )                            {
  const model = "off";
  if (!model || model === "off") return null;
  try {
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(18000),
      body: JSON.stringify({
        model, stream: false, format: "json", options: { temperature: 0, num_predict: 88, num_ctx: 2048 },
        messages: [{
          role: "system",
          content: "你是金沙江工作台的查询解析器。只输出一个 JSON 对象。字段 intent 为 assess（评估/风险/碳/生态/对比）、locate（地图定位）、evidence（数据来源/目录）、soil（土壤属性）、amend（用户明确请求修正数据）、help（其余）。可选字段 station 只填写原话明确出现的站名，year 为原话明确年份，field 为 temperature 或 precipitation，value 为用户明确要设置的新数值。没有就省略。可用站名：" + stations.map(item=>item.name).join("、"),
        }, { role: "user", content: prompt }],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json()                                  ;
    const candidate = JSON.parse(body.message?.content ?? "null")                    ;
    return candidate && intents.has(candidate.intent          ) ? candidate : null;
  } catch {
    return null;
  }
}

function localIntent(prompt        )            {
  const yearMatch = /(?:19|20)\d{2}/u.exec(prompt);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;
  const field = /降水|雨量/u.test(prompt) ? "precipitation" : /气温|温度/u.test(prompt) ? "temperature" : undefined;
  if (/修正|更正|改为|设为|校正|编辑|补录|调整.*(?:为|到)/u.test(prompt)) {
    const amount = /(?:为|到|成|录入)\s*(-?\d+(?:\.\d+)?)(?!\s*年)/u.exec(prompt);
    return { intent:"amend", year, field, value: amount ? Number(amount[1]) : undefined };
  }
  if (/有机碳|容重|土壤酸碱|土壤剖面|土层|soil|pH/i.test(prompt)) return { intent:"soil", year };
  if (/评估|风险|碳|森林|生态|滑坡|退化|水源涵养|土壤保持|EEI|NDVI/u.test(prompt)) return { intent:"assess", year };
  if (/定位|地图|位置|在哪|坐标/u.test(prompt)) return { intent:"locate", year };
  if (/来源|目录|数据|档案|方法|公式|依据|质量/u.test(prompt)) return { intent:"evidence", year };
  return { intent:"help", year };
}

function matchStation(stations           , text                    ) {
  if (!text) return undefined;
  const normalized = text.toLowerCase();
  return [...stations].sort((a,b)=>b.name.length-a.name.length)
    .find(station=>[station.name,station.id,station.en].some(name=>name && normalized.includes(name.toLowerCase())));
}

export async function runEcologyAgent(input                         , context         ) {
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.trim().length > 700) {
    throw new WorkflowError("请使用 1–700 个字符输入问题");
  }
  const prompt = input.prompt.trim();
  const { stations, sourceData } = context;
  const rule = localIntent(prompt);
  const proposed = await interpret(prompt, stations);
  const mode = proposed ? "ollama"          : "local"         ;
  const intent = rule.intent === "help" || (rule.intent === "evidence" && proposed?.intent === "assess")
    ? proposed?.intent ?? rule.intent : rule.intent;
  const directStation = matchStation(stations,prompt)
    ?? (typeof proposed?.station === "string" && prompt.includes(proposed.station) ? matchStation(stations,proposed.station) : undefined);
  const station = directStation ?? (typeof input.stationId === "string" ? stations.find(item=>item.id===input.stationId) : undefined);
  const currentScope = typeof input.scope === "string" && /^(basin|bbox|seg_(up|mid|low)|subbasin:\d{1,16}|zone:[^\s]{1,40})$/u.test(input.scope)
    ? input.scope : "basin";
  const namedScope = /上游/u.test(prompt) ? "seg_up" : /中游/u.test(prompt) ? "seg_mid" : /下游/u.test(prompt) ? "seg_low" : undefined;
  const scope = /全流域|流域总体|流域平均/u.test(prompt) ? "basin"
    : directStation ? "station:"+directStation.id : namedScope ?? (station ? "station:"+station.id : currentScope);
  const year = rule.year ?? (Number.isInteger(input.year) ? Number(input.year) : undefined);
  const evidence                                             = [];

  if (intent === "amend") {
    const field = rule.field;
    const value = rule.value;
    if (!station || !year || !field || value === undefined) {
      return { mode, answer:"准备修正时，请给出站点、档案年份、年均气温或年降水量，以及新数值。", evidence };
    }
    return {
      mode, answer:"已为 "+station.name+" 准备修正草稿。补齐原始资料和修正说明后，可以预览并提交。",
      evidence:[{label:"气候档案修正",detail:year+" 年 · "+(field==="temperature"?"年均气温 °C":"年降水量 mm")+" → "+value}],
      action:{type:"draftAmendment",stationId:station.id,year,field,value},
    };
  }
  if (intent === "locate") {
    if (!station) return { mode, answer:"请提供要定位的站名，例如石鼓、奔子栏或向家坝。", evidence };
    return {
      mode, answer:"已找到 "+station.name+"，可在地图上定位。",
      evidence:[{label:"站点台账",detail:number.format(station.lon)+"° E · "+number.format(station.lat)+"° N"}],
      action:{type:"showStation",stationId:station.id},
    };
  }
  if (intent === "evidence") {
    return {
      mode, answer:"数据资源可查原始站点和气候档案、公开降水、地表覆盖、河网以及其他已接入的档案。",
      evidence:[{label:"当前数据目录",detail:"目录记录来源、样本量和时间范围。",url:"/api/catalog"}],
      action:{type:"showData"},
    };
  }
  if (intent === "soil" && context.newData) {
    const basin = scope.startsWith("subbasin:") ? scope.slice(9) : null;
    const index = await readScientificSummary(context.newData,basin);
    const profile = index?.profiles[0];
    if (!profile) return {mode,answer:"这个范围还没有可用的 SoilGrids 土层统计。",evidence};
    const { ph_h2o, organic_carbon_g_kg, clay_pct, bulk_density_g_cm3 } = profile.properties;
    const soilText = [
      ph_h2o && "pH "+number.format(ph_h2o.mean),
      organic_carbon_g_kg && "有机碳 "+number.format(organic_carbon_g_kg.mean)+" g/kg",
      clay_pct && "黏粒 "+number.format(clay_pct.mean)+"%",
      bulk_density_g_cm3 && "容重 "+number.format(bulk_density_g_cm3.mean)+" g/cm³",
    ].filter(Boolean).join("，");
    return {mode,answer:(basin?"该子流域":"全流域")+" "+profile.depth.replace(/cm$/," cm")+" 土层的样点均值为 "+soilText+"。",
      evidence:[{label:"ISRIC SoilGrids v2.0",detail:profile.samples+" 个有效模型栅格样点 · 样点算术均值",
        url:"https://docs.isric.org/globaldata/soilgrids/"}],action:{type:"showData"}};
  }
  if (intent === "assess") {
    const options = await ecologyOptions(sourceData);
    const targetYear = year ?? options.years.at(-1);
    const params = new URLSearchParams({scope,
      ...(scope === "bbox" && typeof input.bbox === "string" ? {bbox:input.bbox} : {}),
      ...(targetYear === undefined ? {} : {year:String(targetYear)})});
    let report                                             ;
    try {
      report = await evaluateEcology(sourceData,params,targetYear===undefined ? {} : context.overrides(targetYear));
    } catch (error) {
      if (!(error instanceof EcologyInputError)) throw error;
      return { mode, answer:error.message, evidence:[{label:"评估年份",detail:options.years.join("、")} ] };
    }
    const title = report.scope.name;
    const action = {type:"showAssessment",stationId:scope.startsWith("station:")?station?.id:undefined,scope,year:targetYear};
    evidence.push({label:"评估接口",detail:report.summary.count+" / "+report.summary.eligible+" 站有可用输入",url:"/api/ecology/assess?"+params});
    if (!report.summary.means) {
      return {mode,answer:title+"在指定年份缺少符合模型要求的输入。",evidence,action};
    }
    const { eei, risk, carbon, ei } = report.summary.means;
    const ranking = /高风险|风险站点|风险排|哪些站|风险最高/u.test(prompt)
      ? " 筛查分值较高的站点为 " + [...report.stations].sort((a,b)=>b.metrics.risk-a.metrics.risk).slice(0,4)
        .map(item=>item.name+" "+number.format(item.metrics.risk)+"（"+item.riskLevel+"）").join("、") + "。"
      : "";
    const answer = `${title} ${targetYear ?? "多年基准"} 评估显示，EEI 为 ${number.format(eei)} / 100，生态指数 EI 为 ${number.format(ei)} / 100，综合敏感性为 ${number.format(risk)} / 100，模型碳密度为 ${number.format(carbon)} t/ha。${ranking}`;
    evidence.push({label:"模型口径",detail:"区域值为有效站点等权平均。指数和风险来自经验模型，碳密度为模型估算。"});
    const amendments = report.stations.filter(item=>item.inputs.amendedFields.length).length;
    if (amendments) evidence.push({label:"数据修正",detail:amendments+" 个站点采用工作台留痕数据。"});
    return {mode,answer,evidence,action};
  }
  return {
    mode, answer:"可以问我某站或年份的生态风险、碳密度和综合评估，也可以定位站点、查询资料来源或准备气候数据修正。",
    evidence,
  };
}
