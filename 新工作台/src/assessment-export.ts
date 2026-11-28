import type { AssessmentReport } from './ecology-types'
import type { ExportRow } from './export-view'

export function csvField(value:unknown) {
  const raw=value==null?'':String(value)
  const safe=typeof value==='string' && /^[=+\-@\t\r]/.test(raw)?"'"+raw:raw
  return '"'+safe.replaceAll('"','""')+'"'
}
export function assessmentCsv(report:AssessmentReport) {
  const {run,metricDefinitions:definitions}=report
  const header=['运行ID','SHA-256','方法版本','评估区域','范围坐标 W,S,E,N','年份','对照年','情景','空间口径','站点ID','站名','经度','纬度','项目经验等级','研究关注级别',
    ...definitions.map(metric=>metric.name+(metric.unit?' ['+metric.unit+']':''))]
  return '\uFEFF'+[header,...report.stations.map(station=>[
    run.id,run.sha256,report.method,report.scope.name,run.parameters.bbox?.join(',') ?? '',report.year ?? '台账基准',
    report.comparison?.year ?? '',report.scenario.id,report.summary.spatialSupport,station.id,station.name,station.lon,station.lat,
    station.grade,station.riskLevel,...definitions.map(metric=>station.metrics[metric.id]),
  ])].map(row=>row.map(csvField).join(',')).join('\r\n')
}
export function assessmentRows(report:AssessmentReport):ExportRow[] {
  const fmt=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:4})
  const means=report.comparison?.currentMeans ?? report.summary.means
  return [['分析范围',report.scope.name,report.run.parameters.bbox?.join(',') ?? report.scope.id],
    ['分析时段',String(report.year ?? '台账基准'),report.comparison?'对照 '+report.comparison.year:'无对照'],
    ['敏感性假设',report.scenario.name,'非未来预测'],['有效站点',`${report.summary.count} / ${report.summary.eligible}`,'站点等权；非面积统计'],
    ...(report.comparison?[['两期共同样本',String(report.comparison.count),'以下当前值与差值均使用共同样本'] as ExportRow]:[]),
    ...report.metricDefinitions.map(metric=>[metric.name,fmt(means?.[metric.id]),metric.unit] as ExportRow)]
}
export function downloadText(name:string,content:string,type='application/json;charset=UTF-8') {
  const url=URL.createObjectURL(new Blob([content],{type})),link=document.createElement('a')
  link.href=url;link.download=name;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export async function verifyAssessment(report:AssessmentReport) {
  const {run,...payload}=report
  if(!run || !/^[a-f0-9]{64}$/.test(run.sha256))return false
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')===run.sha256
}
