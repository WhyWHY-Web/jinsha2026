import { type CSSProperties, type ReactNode } from 'react'
import { MapPin } from 'lucide-react'
import type { Station } from './data'
import { PanelHeader } from './PanelHeader'
import { DataTable } from './DataTable'
import { warningIndicators, warningLevels, type WarningIndicator, type WarningStation } from './warning'
import './warning.css'

const indicatorIds = Object.keys(warningIndicators) as WarningIndicator[]

function Panel({title, tag, children}: {title:string;tag?:string;children:ReactNode}) {
  return <section className="hud warning-panel"><PanelHeader title={title} tag={tag}/>{children}</section>
}

export function WarningLeft({rows}: {rows:WarningStation[]}) {
  const active = rows.filter(row=>row.level > 0 && row.level < 5)
  return <>
    <Panel title="研究核查优先级" tag="相对分位筛查">
      <div className="warning-total"><strong>{active.length}</strong><span>站需要复核<small>历史静态数据 · 非实时告警</small></span></div>
      <div className="warning-levels">{[4,3,2,1].map(level=><div key={level} style={{'--warning-color':warningLevels[level].color} as CSSProperties}>
        <b>{rows.filter(row=>row.level===level).length}</b><span>{warningLevels[level].name}</span>
      </div>)}</div>
      <p className="research-notice">数据不足 {rows.filter(row=>row.level===5).length} 站；独立列示，不能判为正常。</p>
    </Panel>
    <Panel title="四类指标分项" tag="站点可重复计数">
      <div className="warning-indicators">{indicatorIds.map(id=>{
        const count = rows.filter(row=>row.readings[id].level > 0 && row.readings[id].level < 5).length
        const valid = rows.filter(row=>row.readings[id].value !== null).length
        return <div key={id}><span>{warningIndicators[id].name}</span><b>{count}<small> / {valid}</small></b>
          <i style={{width:(valid ? count/valid*100 : 0)+'%'}}/></div>
      })}</div>
    </Panel>
    <Panel title="筛查规则" tag="研究用途">
      <div className="warning-rules">
        <p>按有值站点相对排序：气温偏高，其余三项偏低视为需关注。各站取最不利指标作为站点级别。</p>
        <dl><div><dt>红</dt><dd>最不利 5%</dd></div><div><dt>橙</dt><dd>5%–10%</dd></div><div><dt>黄</dt><dd>10%–15%</dd></div><div><dt>蓝</dt><dd>15%–20%</dd></div></dl>
        <p>缺测不参与该指标排序。阈值仅用于研究筛查，现场处置应复核实时监测与主管部门标准。</p>
      </div>
    </Panel>
  </>
}

export function WarningRight({rows, indicator, selectedId, onSelect}: {
  rows:WarningStation[]; indicator:WarningIndicator; selectedId:string|null; onSelect:(station:Station)=>void
}) {
  const active = rows.filter(row=>row.level > 0 && row.level < 5)
  return <Panel title="研究关注与缺测" tag={active.length+' 站需复核'}>
    <DataTable className="warning-table-wrap" name="预警站点表" rows={active} initialSort={{key:'level',descending:true}} columns={[
      {key:'station',label:'站点',value:row=>row.station.name,render:row=><button className={selectedId===row.station.id?'warning-selected':''} type="button" onClick={()=>onSelect(row.station)}><MapPin size={12}/>{row.station.name}</button>},
      {key:'level',label:'级别',value:row=>row.level,render:row=><b className="warning-badge" style={{'--warning-color':warningLevels[row.level].color} as CSSProperties}>{warningLevels[row.level].name}</b>,numeric:true},
      {key:'main',label:'关注项',value:row=>warningIndicators[row.main].name},
      {key:'value',label:warningIndicators[indicator].name,value:row=>row.readings[indicator].value,render:row=>row.readings[indicator].value === null ? '—' : row.readings[indicator].value!.toLocaleString('zh-CN',{maximumFractionDigits:warningIndicators[indicator].digits})+' '+warningIndicators[indicator].unit,numeric:true},
    ]}/>
    {!active.length && <p className="empty-list">当前数据无筛查预警站点</p>}
    {rows.some(row=>row.level===5) && <p className="research-notice">数据不足：{rows.filter(row=>row.level===5).map(row=>row.station.name).join('、')}。请补充证据后判断。</p>}
  </Panel>
}
