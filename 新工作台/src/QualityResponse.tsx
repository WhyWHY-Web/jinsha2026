import type { ReactNode } from 'react'
import { ArrowUpRight, MapPin } from 'lucide-react'
import type { MapLocation } from './data'
import { sections, sichuanReports, snapshots, type Level } from '../data/water-quality/reports'
import './quality-response.css'

type Side = 'left' | 'right'
type Locate = (location: MapLocation) => void

const levelLabels = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ']
const levelColors = ['#73d8ff', '#53dcb7', '#e6c569', '#f09a5f', '#f07879']

const baige = {
  id:'baige-landslide', name:'白格滑坡中心', lon:98 + 43 / 60 + 1 / 3600, lat:31 + 4 / 60 + 51 / 3600
} satisfies MapLocation
const rescueReports = {
  origin:'https://dnr.yn.gov.cn/html/2018/ziranziyuanxinxi_1115/22953.html',
  overflow:'https://www.mem.gov.cn/xw/bndt/201811/t20181112_229767.shtml',
  downstream:'https://www.mem.gov.cn/xw/bndt/201811/t20181114_229772.shtml',
  location:'https://cwrh.scu.edu.cn/info/1083/1524.htm'
}
const milestones = [
  { date:'2018-11-03', stage:'险情发生', title:'二次滑坡堵塞金沙江', text:'白格村附近金沙江右岸再次发生山体滑坡，形成堰塞湖。', source:rescueReports.origin, organization:'云南省自然资源厅' },
  { date:'2018-11-12', stage:'防汛响应', title:'泄流槽开始过流', text:'国家防总启动防汛三级应急响应。10 时 50 分，人工开挖的泄流槽开始过流。', source:rescueReports.overflow, organization:'应急管理部' },
  { date:'2018-11-14', stage:'下游监测', title:'过流洪水抵达云南', text:'云南省自然资源厅记录奔子栏水文站 13 时出现洪峰，相应流量为 15,700 m³/s。', source:rescueReports.origin, organization:'云南省自然资源厅' },
  { date:'2018-11-14', stage:'上游监测', title:'堰塞湖水位回落', text:'截至 14 日 7 时，堰塞湖上游 3 公里坝上站水位较最高水位下降 50.38 m。', source:rescueReports.downstream, organization:'应急管理部' }
]

function Panel({title, label, children}: {title:string; label?:string; children:ReactNode}) {
  return <section className="hud qr-panel"><header className="panel-title"><h2>{title}</h2>{label && <span>{label}</span>}</header>{children}</section>
}

function Source({url, children}: {url:string; children:ReactNode}) {
  return <a className="qr-source" href={url} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={12} aria-hidden="true"/></a>
}

function Category({level}: {level:Level}) {
  return <b className="qr-category" style={{color:levelColors[level-1]}}>{levelLabels[level-1]} 类</b>
}

function QualityTable({index, onChange}: {index:number; onChange:(index:number)=>void}) {
  const snapshot = snapshots[index]
  const other = snapshots.find(report=>report.group===snapshot.group && report.year!==snapshot.year)!
  return <Panel title="国考断面水质" label="四川省生态环境厅">
    <div className="qr-content">
      <label className="qr-period">报告期
        <select value={index} onChange={event=>onChange(Number(event.target.value))}>
          {snapshots.map((report,i)=><option key={report.label} value={i}>{report.label}</option>)}
        </select>
      </label>
      <table className="qr-table">
        <thead><tr><th scope="col">监测断面</th><th scope="col">{snapshot.year}</th><th scope="col">{other.year}对照</th></tr></thead>
        <tbody>{sections.map((section,i)=><tr key={section.id}>
          <th scope="row">{section.name}<small>{section.area} · {section.river}</small></th>
          <td><Category level={snapshot.values[i]}/></td><td><Category level={other.values[i]}/></td>
        </tr>)}</tbody>
      </table>
      <Source url={snapshot.source}>查阅本期报告</Source>
    </div>
  </Panel>
}

function QualitySummary({index}: {index:number}) {
  const snapshot = snapshots[index]
  const other = snapshots.find(report=>report.group===snapshot.group && report.year!==snapshot.year)!
  const counts = levelLabels.map((_,i)=>snapshot.values.filter(level=>level===i+1).length)
  let end = 0
  const segments = counts.flatMap((count,i)=>{
    if (!count) return []
    const start = end
    end += count / snapshot.values.length * 100
    return [`${levelColors[i]} ${start}% ${end}%`]
  })
  const improved = snapshot.values.filter((value,i)=>value<other.values[i]).length
  const declined = snapshot.values.filter((value,i)=>value>other.values[i]).length
  return <>
    <Panel title="断面类别分布" label={snapshot.label}>
      <div className="qr-content qr-distribution">
        <div className="qr-ring" style={{background:segments.length > 1 ? `conic-gradient(${segments.join(',')})` : levelColors[counts.findIndex(count=>count>0)]}} aria-hidden="true">
          <div><b>{snapshot.values.length}</b><small>选录断面</small></div>
        </div>
        <dl>{counts.map((count,i)=>count > 0 && <div key={i}><dt><Category level={(i+1) as Level}/></dt><dd>{count} 处</dd></div>)}</dl>
      </div>
      <p className="qr-note">统计金沙江干流和支流的 {sections.length} 个选录断面。</p>
    </Panel>
    <Panel title="同口径类别变化" label={other.label+'对照'}>
      <dl className="qr-comparison qr-content">
        <div><dt>类别改善</dt><dd>{improved}</dd></div>
        <div><dt>类别稳定</dt><dd>{sections.length-improved-declined}</dd></div>
        <div><dt>类别下降</dt><dd>{declined}</dd></div>
      </dl>
    </Panel>
    <Panel title="监测口径">
      <div className="qr-content qr-sources">
        <p>表格展示公开报告的地表水类别和上年同期结果。连续监测指标与浓度记录尚待接入。</p>
        <Source url={sichuanReports.half}>2024 年上半年水质统计表</Source>
        <Source url={sichuanReports.summer}>2024 年 1–8 月水质统计表</Source>
        <Source url={sichuanReports.winter}>2024 年 1–2 月水质统计表</Source>
        <Source url={sichuanReports.january}>2024 年 1 月水质统计表</Source>
        <Source url={sichuanReports.annual}>2023 年年度水质统计表</Source>
      </div>
    </Panel>
  </>
}

function EmergencyTimeline({onLocate}: {onLocate:Locate}) {
  return <>
    <Panel title="白格堰塞湖" label="2018 年历史事件">
      <div className="qr-content">
        <p className="qr-lead">四川白玉与西藏江达交界</p>
        <button className="qr-locate" type="button" onClick={()=>onLocate(baige)}><MapPin size={14}/>定位白格滑坡中心</button>
        <Source url={rescueReports.location}>中心坐标来源 · 四川大学</Source>
      </div>
    </Panel>
    <Panel title="应急响应时间线" label="4 个节点">
      <div className="qr-content qr-milestones">
        {milestones.map((row,i)=><details key={row.title} open={i===0}>
          <summary><span><time>{row.date}</time><small>{row.stage}</small></span><b>{row.title}</b></summary>
          <p>{row.text}</p><Source url={row.source}>{row.organization}</Source>
        </details>)}
      </div>
    </Panel>
  </>
}

function EmergencySummary() {
  return <>
    <Panel title="响应与防御" label="2018-11-12">
      <dl className="qr-facts qr-content"><div><dt>国家防总防汛响应</dt><dd>Ⅲ 级</dd></div>
        <div><dt>四川、西藏当时已转移安置</dt><dd>3.42 <small>万人</small></dd></div></dl>
      <div className="qr-content qr-meta"><Source url={rescueReports.overflow}>应急管理部通报</Source></div>
    </Panel>
    <Panel title="洪峰过站记录" label="2018-11-14 13:00">
      <dl className="qr-facts qr-content"><div><dt>奔子栏水文站洪峰流量</dt><dd>15,700 <small>m³/s</small></dd></div>
        <div><dt>奔子栏水文站洪峰水位</dt><dd>2,018.98 <small>m</small></dd></div></dl>
      <div className="qr-content qr-meta"><Source url={rescueReports.origin}>云南省自然资源厅通报</Source></div>
    </Panel>
  </>
}

export function QualityResponse({mode, side, onLocate, qualityIndex, onQualityIndexChange}: {
  mode:'quality'|'emergency'; side:Side; onLocate:Locate; qualityIndex:number; onQualityIndexChange:(index:number)=>void
}) {
  if (mode==='quality') return side==='left'
    ? <QualityTable index={qualityIndex} onChange={onQualityIndexChange}/>
    : <QualitySummary index={qualityIndex}/>
  return side==='left' ? <EmergencyTimeline onLocate={onLocate}/> : <EmergencySummary/>
}
