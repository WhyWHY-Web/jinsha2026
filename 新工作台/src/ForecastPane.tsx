import { Download,RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Station } from './data'
import type { useEcology } from './ecology-state'
import { forecastDays,forecastUsable } from '../server/forecast-model'
import type { ForecastReply } from './live-state'
import { dateTime,freshnessNames } from './live-state'
import { downloadText } from './assessment-export'
import { PanelHeader } from './PanelHeader'

type Props={side:'left'|'right'|'setup'|'results'|'summary';ecology:ReturnType<typeof useEcology>;stations:Station[];reply:ForecastReply|null;error:boolean;day:string;
  onDay:(day:string)=>void;onStation:(id:string|null)=>void;onLatest:()=>void;onSave:()=>void;taskControls?:ReactNode}
const fmt=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:2})

export function ForecastPane({side,ecology,stations,reply,error,day,onDay,onStation,onLatest,onSave,taskControls}:Props) {
  const snapshot=reply?.snapshot,usable=snapshot && forecastUsable(snapshot)
  const ids=new Set(ecology.report?.stations.map(row=>row.id) ?? [])
  const scoped=snapshot?.stations.filter(row=>ids.has(row.id)) ?? []
  const station=scoped.find(row=>row.id===ecology.selectedStationId) ?? scoped[0]
  const days=usable && station?forecastDays(station):[]
  const chosen=day?days.find(row=>row.date===day):days[0]
  function choose(value:string) {
    if(value.startsWith('station:'))onStation(value.slice(8))
    else {ecology.setScope(value);onStation(null)}
  }
  if(side==='summary')return <div className="workspace-summary forecast-summary">
    <b>{station?.name ?? ecology.report?.scope.name ?? '所选范围'} · 气象驱动</b>
    {error && <p role="alert">预报读取失败，请到数据与方法检查。</p>}
    {!usable ? <p role="status">暂无有效预报。请在高级条件检查批次与有效期。</p>:<>
      <div className="forecast-days" aria-label="预报有效日期">{days.map(row=><button key={row.date} type="button" aria-pressed={chosen?.date===row.date} onClick={()=>onDay(row.date)}><span>{row.date.slice(5)}</span><b>{fmt(row.maxTemperature)}°</b><small>{fmt(row.precipitation)} mm / {row.hours}h</small></button>)}</div>
      {!station && <p>该范围没有研究格点，不能外推预报。</p>}
      {day && !chosen && <p role="alert">所选日期不在本批次剩余有效时段内，请重新选择。</p>}
      <p>模型预报，非站点实测 · 有效至 {dateTime(snapshot?.validTo)} · 生态风险待校准</p>
    </>}
  </div>
  if(side!=='right')return <>
    {side!=='results' && <section className="hud research-card"><PanelHeader title="预报分析条件" tag="模型预报"/><div className="research-content">
      {taskControls}
      <p>先检查天气变化，再结合植被、地形和现场资料核查。生态胁迫模型仍待校准。</p>
      <label>分析范围<select aria-label="预报分析范围" value={ecology.activeScope} onChange={event=>choose(event.target.value)}>
        {ecology.options?.regions.map(region=><option key={region.id} value={region.id}>{region.name} · {region.count} 站</option>)}
        {ecology.activeScope==='bbox' && <option value="bbox">当前框选范围</option>}
        <optgroup label="研究站点">{stations.map(row=><option key={row.id} value={'station:'+row.id}>{row.name}</option>)}</optgroup>
      </select></label>
      <button type="button" onClick={onLatest}><RefreshCw size={14}/>切换最新已获取批次</button>
      {error && <p className="research-error" role="alert">预报服务读取失败，可到数据与方法检查采集状态。</p>}
      {!snapshot && <p className="research-notice" role="status">暂无有效预测资料。首次采集可能需要约一分钟；断网时请检查网络并在数据与方法重试。</p>}
      {snapshot && !usable && <p className="research-error" role="alert">该批次已过期，停止展示未来压力。仍可导出原始快照作复核，请获取新的有效批次。</p>}
      {snapshot && <dl><div><dt>抓取时间</dt><dd>{dateTime(snapshot.retrievedAt)}</dd></div>
        <div><dt>源起报时间</dt><dd>源接口未提供</dd></div><div><dt>有效期</dt><dd>{dateTime(snapshot.validFrom)} 至 {dateTime(snapshot.validTo)}</dd></div>
        <div><dt>资料状态</dt><dd>{reply.sourceStatus ? freshnessNames[reply.sourceStatus.state] : '离线快照'} · {usable?'有效时段内':'已失效'}</dd></div></dl>}
    </div></section>}
    {side!=='setup' && usable && <section className="hud research-card"><PanelHeader title="逐日驱动证据" tag={scoped.length+' 个研究格点'}/><div className="research-content">
      {!station ? <p>该范围没有研究格点，不能外推预报。请改选有资料的站点或区域。</p> : <>
        <label>切换为单站分析<select aria-label="查看预报格点" value={station.id} onChange={event=>onStation(event.target.value)}>{(ecology.selectedStationId?snapshot?.stations.filter(row=>stations.some(item=>item.id===row.id)) ?? []:scoped).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        {day && !chosen && <p className="research-error" role="alert">所选日期不在本批次的剩余有效时段内，请选择下方日期。未自动替换成其他日期。</p>}
        <div className="forecast-days" aria-label="预报有效日期">{days.map(row=><button key={row.date} type="button" aria-pressed={chosen?.date===row.date} onClick={()=>onDay(row.date)}>
          <span>{row.date.slice(5)}</span><b>{fmt(row.maxTemperature)}°</b><small>{fmt(row.precipitation)} mm / {row.hours}h</small></button>)}</div>
        {chosen && <><h3>{station.name} · {chosen.date}</h3><dl>
          <div><dt>最高气温（{chosen.temperatureCount}/{chosen.hours}h）</dt><dd>{fmt(chosen.maxTemperature)} °C</dd></div><div><dt>降水 / 参考蒸散 ET₀</dt><dd>{fmt(chosen.precipitation)} / {fmt(chosen.et0)} mm</dd></div>
          <div><dt>P−ET₀ 气象差值</dt><dd>{fmt(chosen.balance)} mm</dd></div><div><dt>最大 VPD（{chosen.vpdCount}/{chosen.hours}h）</dt><dd>{fmt(chosen.maxVpd)} kPa</dd></div>
        </dl><p className="research-notice">{chosen.hours<24?'当日仅含尚有效的部分小时。':'当日含 24 小时。'}缺测不补零；P−ET₀ 为负仅提示需核查的水分线索。</p></>}
      </>}
    </div></section>}
    {side==='results' && !usable && <div className="research-notice" role="status">暂无有效预测资料。请先检查左侧预报有效期和资料状态；数据与方法提供采集记录与重试入口。</div>}
  </>
  return <>
    <section className="hud research-card"><PanelHeader title="模型与适用边界" tag="研究试验"/><div className="research-content">
      <h3>气象驱动已接入，生态风险待验证</h3>
      <p>目前提供确定性天气预报与驱动差值，不输出火灾、滑坡或植被死亡概率。尚无独立时间隔离回测结果，不显示准确率。</p>
      {snapshot && <><p>{snapshot.productVersion}</p><p>批次 <code>{snapshot.id}</code>；链接固定本批次，更新必须显式选择。</p><ul>{snapshot.notes.map(note=><li key={note}>{note}</li>)}</ul></>}
      <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo 数据与变量说明</a>
    </div></section>
    <section className="hud research-card"><PanelHeader title="生成研究核查清单"/><div className="research-content">
      <p>核查对象：{station?.name ?? ecology.report?.scope.name ?? '当前范围'}。有效日期：{chosen?.date ?? '尚无有效时段'}。</p>
      <ul><li>对照实测雨量、温湿度与站点海拔，检查格点偏差。</li><li>采集土壤含水量、林冠状态及照片，核对水分线索。</li><li>有明显降水时，叠加坡地背景并核对现场；不据此判定滑坡。</li></ul>
      {station && <p>实际模型格点：{station.grid.lon.toFixed(3)}°E，{station.grid.lat.toFixed(3)}°N；高程 {fmt(station.grid.elevation)} m。研究站海拔 {fmt(station.elevation)} m。</p>}
      <div className="research-actions"><button disabled={!usable || !station} type="button" onClick={onSave}>保存预报证据</button>
        <button disabled={!snapshot} type="button" onClick={()=>snapshot && downloadText('金沙江-气象批次-'+snapshot.id+'.json',JSON.stringify({snapshot,selection:{scope:ecology.activeScope,bbox:ecology.bbox,day:chosen?.date,station:station?.id},
          checklist:['核对实测气象与高差','获取土壤水分与林冠证据','结合坡地背景现场核查'],validation:'尚未校准；不提供生态灾害概率'},null,2))}><Download size={14}/>证据 JSON</button></div>
    </div></section>
  </>
}
