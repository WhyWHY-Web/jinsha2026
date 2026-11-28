import { useFloodReplay } from './flood-state'
import { ArrowUpRight, CalendarRange, Gauge, Pause, Play, Waves } from 'lucide-react'
import type { FloodArchive, FloodEvent, FloodLevel, FloodStationDay } from '../data/flood/types'
import { PanelHeader } from './PanelHeader'
import './flood.css'

export const floodColors: Record<FloodLevel, string> = {
  usual: '#67cfff',
  high: '#ffd081',
  veryHigh: '#ff785d',
}

const levels: Record<FloodLevel, { label: string, range: string }> = {
  usual: { label:'低于参考值', range:'< 1.0 倍 P95' },
  high: { label:'达到参考值', range:'1.0 ≤ 倍数 < 1.2' },
  veryHigh: { label:'明显高于参考值', range:'≥ 1.2 倍 P95' },
}
const playbackRates = [.5, 1, 2, 4] as const
type PlaybackRate = typeof playbackRates[number]
const formatFlow = new Intl.NumberFormat('zh-CN', { maximumFractionDigits:0 }).format

type Replay = ReturnType<typeof useFloodReplay>
type PanelProps = { replay: Replay, selectedId?: string | null, onSelectStation:(id:string)=>void }

function ProcessChart({ event, stationId, index, threshold, onSelect }: {
  event:FloodEvent, stationId:string, index:number, threshold:number, onSelect:(index:number)=>void
}) {
  const values = event.frames.map(frame=>frame.stations.find(station=>station.id===stationId)?.value)
  const max = Math.max(100,Math.ceil(Math.max(threshold,...values.map(value=>value ?? 0))*1.08/100)*100)
  const width = 280, height = 126, left = 39, right = width-8, top = 12, bottom = height-23
  const x = (i:number) => left+(right-left)*i/Math.max(1,event.frames.length-1)
  const y = (v:number) => bottom-(bottom-top)*v/max
  const path = values.reduce((line,value,i)=>value === undefined ? line :
    line+(i===0 || values[i-1]===undefined ? 'M' : 'L')+x(i).toFixed(2)+' '+y(value).toFixed(2)+' ', '')
  const dateTicks = [...new Set([0, Math.floor((event.frames.length-1)/2), event.frames.length-1])]
  const current = values[index]
  return <svg className="flood-plot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="逐日流量过程线及第95百分位参考线"
    onClick={pointer=>{
      const matrix = pointer.currentTarget.getScreenCTM()
      if (!matrix) return
      const point = new DOMPoint(pointer.clientX,pointer.clientY).matrixTransform(matrix.inverse())
      onSelect(Math.round((point.x-left)/(right-left)*(values.length-1)))
    }}>
    <defs><linearGradient id="flood-plot-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#41a7ff" stopOpacity=".38"/><stop offset="100%" stopColor="#41a7ff" stopOpacity=".02"/>
    </linearGradient></defs>
    {[max, Math.round(max*2/3), Math.round(max/3), 0].map(value=>
      <g key={value}><line className="flood-grid" x1={left} x2={right} y1={y(value)} y2={y(value)}/>
        <text x={left-5} y={y(value)+3} textAnchor="end">{formatFlow(value)}</text></g>)}
    {values.every(value=>value!==undefined) && <path fill="url(#flood-plot-fill)"
      d={`${path}L${right} ${bottom} L${left} ${bottom} Z`}/>}
    <line className="flood-reference" x1={left} x2={right} y1={y(threshold)} y2={y(threshold)}/>
    <path className="flood-discharge-line" d={path}/>
    {current!==undefined && <g><line className="flood-scrub-line" x1={x(index)} x2={x(index)} y1={top} y2={bottom}/>
      <circle className="flood-cursor" cx={x(index)} cy={y(current)} r="3.8"/></g>}
    {dateTicks.map((tick,i)=><text key={tick} x={x(tick)} y={height-6} textAnchor={i===0?'start':i===dateTicks.length-1?'end':'middle'}>
      {event.frames[tick]?.date.slice(5)}</text>)}
  </svg>
}

export function FloodLeft({ replay,selectedId,onSelectStation }: PanelProps) {
  const { archive,event,frame } = replay
  const station = archive?.stations.find(item=>item.id===(selectedId ?? archive.referenceId))
  const current = frame?.stations.find(item=>item.id===station?.id)
  return <>
    <section className="hud flood-panel">
      <PanelHeader title="逐日流量过程线" tag="历史模拟" state={replay.failed ? 'error' : !archive ? 'loading' : undefined}/>
      {archive && station && event ? <>
        <div className="flood-chart-toolbar">
          <select aria-label="回放站点" value={station.id} onChange={change=>onSelectStation(change.target.value)}>
            {archive.stations.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <time dateTime={frame?.date}>{frame?.date}</time>
        </div>
        <div className="flood-reading">
          <strong style={{color:current && floodColors[current.level]}}>{current ? formatFlow(current.value) : '—'}</strong>
          <small>m³/s</small>
        </div>
        <ProcessChart event={event} stationId={station.id} index={replay.index} threshold={station.threshold} onSelect={replay.selectFrame}/>
        <div className="flood-chart-key"><span><i/> 模拟流量</span><span><i/> P95 · {formatFlow(station.threshold)} m³/s</span></div>
      </> : <div className="flood-state" role="status">{replay.failed ? <>
        历史流量档案读取失败 <button type="button" onClick={replay.retry}>重试</button>
      </> : '正在读取历史流量档案…'}</div>}
    </section>
    {archive && <section className="hud flood-panel">
      <PanelHeader title="代表性洪峰" tag={'向家坝 · '+archive.events.length+' 期'}/>
      <div className="flood-events">
        {archive.events.map(item=><button type="button" key={item.id}
          aria-pressed={event?.id===item.id} onClick={()=>replay.selectEvent(item.id)}>
          <CalendarRange size={13}/><time dateTime={item.peakDate}>{item.peakDate}</time>
          <strong>{formatFlow(item.peak)} <small>m³/s</small></strong>
        </button>)}
      </div>
    </section>}
  </>
}

function LevelDot({ level }: { level:FloodLevel }) {
  return <i className="flood-marker-dot" aria-hidden="true" style={{color:floodColors[level]}}/>
}

function StationRow({ station, selected, onSelect }: {
  station:FloodStationDay, selected:boolean, onSelect:()=>void
}) {
  return <button type="button" className="flood-station-row" onClick={onSelect} aria-pressed={selected}>
    <LevelDot level={station.level}/>
    <span>{station.name}<small>{levels[station.level].label}</small></span>
    <strong style={{color:floodColors[station.level]}}>{formatFlow(station.value)} <small>m³/s</small></strong>
    <ArrowUpRight size={12}/>
  </button>
}

export function FloodRight({ replay,selectedId,onSelectStation }: PanelProps) {
  const { archive,event,frame } = replay
  if (!archive || !event || !frame) return null
  return <>
    <section className="hud flood-panel">
      <PanelHeader title="向家坝洪峰" tag="事件摘要"/>
      <div className="flood-metrics">
        <div><Waves size={14}/><span><small>峰值流量</small><strong>{formatFlow(event.peak)} <small>m³/s</small></strong></span></div>
        <div><CalendarRange size={14}/><span><small>峰值日期</small><strong>{event.peakDate}</strong></span></div>
        <div><Gauge size={14}/><span><small>窗口内达到参考值</small><strong>{event.daysAbove} <small>天</small></strong></span></div>
      </div>
    </section>
    <section className="hud flood-panel">
      <PanelHeader title="站点模型流量" tag={frame.date}/>
      <div className="flood-stations">{frame.stations.map(station=><StationRow key={station.id} station={station}
        selected={station.id===(selectedId ?? archive.referenceId)} onSelect={()=>onSelectStation(station.id)}/>)}</div>
    </section>
    <section className="hud flood-panel">
      <PanelHeader title="回放数据口径" tag="GloFAS v4"/>
      <div className="flood-method">
        <div className="flood-levels">{(Object.entries(levels) as [FloodLevel,(typeof levels)[FloodLevel]][]).map(([level,meta])=>
          <div key={level}><LevelDot level={level}/><span>{meta.label}</span><small>{meta.range}</small></div>)}</div>
        <p>P95 取各格点在 {archive.start.slice(0,4)}–{archive.end.slice(0,4)} 年历史日流量的第 95 百分位。颜色表示相对流量。</p>
        <p>档案含 {formatFlow(archive.rows)} 条模型记录。按向家坝各年最大日流量选取 {archive.events.length} 期，回放峰日前后各十日。</p>
        <a href={archive.sourceUrl} target="_blank" rel="noreferrer">{archive.source} <ArrowUpRight size={11}/></a>
      </div>
    </section>
  </>
}

export function FloodTimeline({ replay }: { replay:Replay }) {
  const { event, frame, playing, lastIndex, index } = replay
  return <section className="timebar flood-timebar" aria-label="洪水回放时间轴">
    <button type="button" className="play" disabled={!frame} onClick={replay.toggle} aria-label={playing?'暂停洪水回放':'播放洪水回放'}>
      {playing?<Pause size={17}/>:<Play size={17}/>}</button>
    <div className="year"><small>回放日期 · UTC</small><strong>{frame?.date ?? '—'}</strong></div>
    <div className="scrubber">
      <input type="range" aria-label="回放日期" aria-valuetext={frame?.date ?? '数据加载中'}
        min={0} max={lastIndex} value={index} disabled={!frame} onChange={change=>replay.selectFrame(Number(change.target.value))}/>
      <div><span>{event?.start ?? '—'}</span>
        {event && <button type="button" className="flood-peak-jump" onClick={()=>replay.selectFrame(replay.peakIndex)}>定位峰日 {event.peakDate.slice(5)}</button>}
      <span>{event?.end ?? '—'}</span></div>
    </div>
    <div className="flood-rates" aria-label="回放速度">{playbackRates.map(speed=><button key={speed} type="button"
      disabled={!frame} aria-label={speed+' 倍播放速度'} aria-pressed={speed===replay.speed} onClick={()=>replay.setSpeed(speed)}>{speed}×</button>)}</div>
  </section>
}
