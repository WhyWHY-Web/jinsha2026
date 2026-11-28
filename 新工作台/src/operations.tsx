import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Building2, CalendarDays, MapPin, Search, Waypoints } from 'lucide-react'
import type { DispatchEntry, DispatchKind, EngineeringCatalog, EngineeringProject } from '../data/engineering/types'
import type { Station, StationMark } from './data'
import { PanelHeader } from './PanelHeader'
import { DataTable } from './DataTable'
import './operations.css'

type OperationsScene = 'engineering' | 'dispatch'
type PanelProps = {
  scene: OperationsScene
  side: 'left' | 'right'
  catalog: EngineeringCatalog | null
  error: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  dispatchEventId?: string | null
  onSelectDispatchEvent?: (id: string) => void
}

const capacities = new Intl.NumberFormat('zh-CN')
const generation = new Intl.NumberFormat('zh-CN', { maximumFractionDigits:1 })
const projectColors = ['#58c3ff','#4de1c2','#7498fd','#bea4fb']
const categories = ['生态试验','管理文件','试验总结'] as const
const kindColors: Record<DispatchKind,string> = {
  生态试验:'#5edacb',
  管理文件:'#82b5ff',
  试验总结:'#e5b36e',
}

function currentEvent(catalog: EngineeringCatalog, id?: string | null) {
  return catalog.dispatch.find(event=>event.id===id) ?? catalog.dispatch[0]
}

function Panel({title,tag,children}: {title:string;tag:string;children:ReactNode}) {
  return <section className="hud operations-panel">
    <PanelHeader title={title} tag={tag}/>
    {children}
  </section>
}

function Source({url,children}: {url:string;children:ReactNode}) {
  return <a className="operations-source" href={url} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13}/></a>
}

function ProjectRow({project,selected,onSelect,highlighted}: {
  project:EngineeringProject;selected:boolean;onSelect:(id:string)=>void;highlighted?:boolean
}) {
  return <button className="operations-row" type="button" onClick={()=>onSelect(project.id)} aria-pressed={selected}>
    <span className="operation-node"><Building2 size={15}/></span>
    <span><b>{project.name}</b><small>第 {project.cascade} 级 · {project.region}</small></span>
    {highlighted === undefined
      ? <span className="operations-value">{capacities.format(project.installedMW)} <small>MW</small></span>
      : <span className={highlighted ? 'operations-member' : 'operations-quiet'}>{highlighted ? '涉及' : '未列入'}</span>}
  </button>
}

function EngineeringList({catalog,selectedId,onSelect}: {
  catalog:EngineeringCatalog;selectedId:string|null;onSelect:(id:string)=>void
}) {
  const [search,setSearch] = useState('')
  const query=search.trim()
  const projects=catalog.projects.filter(project=>(project.name+' '+project.region).includes(query))
  const total=catalog.projects.reduce((sum,project)=>sum+project.installedMW,0)
  let offset = 0
  const stops = catalog.projects.map((project,index)=>{
    const start = offset
    offset += project.installedMW/total*100
    return projectColors[index]+' '+start+'% '+offset+'%'
  })
  return <>
    <Panel title="梯级工程台账" tag={catalog.projects.length+' 座'}>
      <label className="search"><Search size={14}/><input aria-label="搜索工程" value={search} placeholder="搜索电站或所在地" onChange={e=>setSearch(e.target.value)}/></label>
      <div className="operations-list">
        {projects.map(project=><ProjectRow key={project.id} project={project} selected={selectedId===project.id} onSelect={onSelect}/>)}
        {!projects.length && <p className="operations-note" role="status">暂无匹配工程</p>}
      </div>
    </Panel>
    <Panel title="装机容量构成" tag={catalog.baselineYear+' 年报'}>
      <div className="operations-capacity">
        <div className="operations-ring" style={{background:'conic-gradient('+stops.join(',')+')'}}>
          <span><strong>{capacities.format(total)}</strong><small>MW</small></span>
        </div>
        <ul aria-label="梯级装机容量占比">
          {catalog.projects.map((project,index)=><li key={project.id}>
            <i style={{background:projectColors[index]}}/><span>{project.name}</span><b>{(project.installedMW/total*100).toFixed(1)}%</b>
          </li>)}
        </ul>
      </div>
    </Panel>
  </>
}

function EngineeringDetails({catalog,selectedId,onSelect}: {
  catalog:EngineeringCatalog;selectedId:string|null;onSelect:(id:string)=>void
}) {
  const selected=catalog.projects.find(project=>project.id===selectedId)
  const maxGeneration=Math.max(...catalog.projects.map(project=>project.annualGeneration2023))
  return <>
    <Panel title={selected?.name ?? '工程参数对照'} tag="公开台账">
      {selected ? <dl className="operations-metrics">
        <div><dt>装机容量</dt><dd>{capacities.format(selected.installedMW)} <small>MW</small></dd></div>
        <div><dt>正常蓄水位</dt><dd>{selected.designLevelM} <small>m</small></dd></div>
        <div><dt>年发电量</dt><dd>{generation.format(selected.annualGeneration2023)} <small>亿 kWh</small></dd></div>
        <div><dt>首批投产</dt><dd>{selected.firstOperationYear} <small>年</small></dd></div>
      </dl> : <DataTable className="operations-table-wrap" name="工程参数对照" rows={catalog.projects} columns={[
        {key:'name',label:'工程',value:project=>project.name,render:project=><button type="button" onClick={()=>onSelect(project.id)}>{project.name}</button>},
        {key:'level',label:'正常蓄水位 m',value:project=>project.designLevelM,numeric:true},
        {key:'year',label:'首批投产',value:project=>project.firstOperationYear,numeric:true},
      ]}/>}
      <Source url={catalog.sourceUrl}>{catalog.issuer} {catalog.baselineYear} 年度报告</Source>
    </Panel>
    <Panel title="梯级年发电量" tag={catalog.baselineYear+' 年 · 亿 kWh'}>
      <div className="operations-bars">
        {catalog.projects.map((project,index)=><button key={project.id} type="button" onClick={()=>onSelect(project.id)} aria-pressed={selectedId===project.id}>
          <span>{project.name}</span><strong>{generation.format(project.annualGeneration2023)}</strong>
          <span className="operations-track"><i style={{width:project.annualGeneration2023/maxGeneration*100+'%',background:projectColors[index]}}/></span>
        </button>)}
      </div>
    </Panel>
  </>
}

function EventRow({event,active,onSelect}: {event:DispatchEntry;active:boolean;onSelect?:(id:string)=>void}) {
  return <button className="operations-event" type="button" aria-pressed={active} onClick={()=>onSelect?.(event.id)}>
    <i className="operations-point" style={{background:kindColors[event.kind]}}/>
    <span><small><time dateTime={event.date}>{event.dateLabel}</time><em>{event.kind}</em></small><b>{event.title}</b></span>
  </button>
}

function DispatchArchive({catalog,dispatchEventId,onSelectDispatchEvent}: {
  catalog:EngineeringCatalog;dispatchEventId?:string|null;onSelectDispatchEvent?:(id:string)=>void
}) {
  const event=currentEvent(catalog,dispatchEventId)
  return <>
    <Panel title="生态调度档案" tag={catalog.dispatch.length+' 条'}>
      <div className="operations-events">
        {catalog.dispatch.map(item=><EventRow key={item.id} event={item} active={event?.id===item.id} onSelect={onSelectDispatchEvent}/>)}
      </div>
    </Panel>
    <Panel title="档案类型统计" tag="公开资料">
      <div className="operations-counts">
        {categories.map(kind=><div key={kind}>
          <strong style={{color:kindColors[kind]}}>{catalog.dispatch.filter(item=>item.kind===kind).length}</strong><small>{kind}</small>
        </div>)}
      </div>
    </Panel>
  </>
}

function DispatchDetails({catalog,dispatchEventId,selectedId,onSelect}: {
  catalog:EngineeringCatalog;dispatchEventId?:string|null;selectedId:string|null;onSelect:(id:string)=>void
}) {
  const event=currentEvent(catalog,dispatchEventId)
  return <>
    <Panel title="档案详情" tag="历史记录">
      {event && <article className="operations-detail">
        <span><CalendarDays size={13}/><time dateTime={event.date}>{event.dateLabel}</time><em>{event.kind}</em></span>
        <h3>{event.title}</h3>
        <p>{event.description}</p>
        <Source url={event.url}>{event.source}原文</Source>
      </article>}
    </Panel>
    <Panel title="梯级关联" tag={event ? event.projects.length+' 座涉及' : '历史记录'}>
      <div className="operations-list">
        {catalog.projects.map(project=><ProjectRow key={project.id} project={project} selected={selectedId===project.id}
          highlighted={event?.projects.includes(project.id) ?? false} onSelect={onSelect}/>)}
      </div>
      <p className="operations-note"><MapPin size={12}/> 点击电站定位 · 高亮为档案涉及的梯级</p>
    </Panel>
  </>
}

export function OperationsPanel({scene,side,catalog,error,selectedId,onSelect,dispatchEventId,onSelectDispatchEvent}: PanelProps) {
  if (!catalog) {
    const title=scene === 'dispatch' ? '生态调度档案' : '梯级工程台账'
    return side === 'left' ? <Panel title={title} tag="公开资料">
      <p className="operations-note" role="status"><Waypoints size={15}/>{error ? '读取档案失败，切换专题后重试' : '正在加载档案'}</p>
    </Panel> : null
  }
  if (scene === 'engineering') {
    const View=side === 'left' ? EngineeringList : EngineeringDetails
    return <View catalog={catalog} selectedId={selectedId} onSelect={onSelect}/>
  }
  return side === 'left'
    ? <DispatchArchive catalog={catalog} dispatchEventId={dispatchEventId} onSelectDispatchEvent={onSelectDispatchEvent}/>
    : <DispatchDetails catalog={catalog} dispatchEventId={dispatchEventId} selectedId={selectedId} onSelect={onSelect}/>
}
