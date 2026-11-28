import { useEffect,useRef,useState } from 'react'
import { Download,FolderOpen,RefreshCw,Upload } from 'lucide-react'
import type { AssessmentReport } from './ecology-types'
import type { Scene } from './data'
import type { LiveStatus,ObservationSnapshot } from '../server/live-types'
import { dateTime,freshnessNames } from './live-state'
import { assessmentCsv,assessmentRows,downloadText } from './assessment-export'
import { removeRun,savedRuns,saveRun,verifySaved,type SavedRun } from './saved-runs'
import { forecastUsable } from '../server/forecast-model'

const fmt=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:4})
export function ResearchCenter({mode,status,error,report,onNavigate,onRefresh}: {
  mode:'methods'|'results';status:LiveStatus|null;error:string;report:AssessmentReport|null;
  onNavigate:(scene:Scene)=>void;onRefresh:()=>Promise<void>
}) {
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[runs,setRuns]=useState<SavedRun[]>([])
  const [selectedId,setSelectedId]=useState(''),[observations,setObservations]=useState<ObservationSnapshot|null>(null)
  const [observationError,setObservationError]=useState('')
  const detail=useRef<HTMLDivElement>(null)
  const selected=runs.find(run=>run.id===selectedId) ?? runs[0]
  useEffect(()=>{try{setRuns(savedRuns())}catch(error){setMessage(String((error as Error).message))}},[])
  const lastSuccess=status?.sources.find(source=>source.id==='ghcn')?.lastSuccessAt
  useEffect(()=>{
    if(mode!=='methods')return
    const controller=new AbortController()
    fetch('/api/live/observations',{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('近期观测暂不可读取')
      const value=await response.json();if(!controller.signal.aborted){setObservations(value.snapshot);setObservationError('')}
    }).catch(error=>{if(!controller.signal.aborted)setObservationError(error.message)})
    return ()=>controller.abort()
  },[mode,lastSuccess])
  async function refresh() {
    if(busy)return
    setBusy(true);setMessage('')
    try{await onRefresh();setMessage('检查已提交，采集在后台继续。静态网站需重新发布快照。')}
    catch(error){setMessage(String((error as Error).message))}finally{setBusy(false)}
  }
  async function importRun(file?:File) {
    if(!file)return
    try {
      if(file.size>8_000_000)throw new Error('证据文件超过 8 MB')
      const value=JSON.parse(await file.text()) as SavedRun
      if(!await verifySaved(value))throw new Error('证据格式或 SHA-256 校验未通过')
      saveRun(value);setRuns(savedRuns());setSelectedId(value.id);setMessage('证据完整性校验通过，已导入原始快照。')
    }catch(error){setMessage(String((error as Error).message))}
  }
  async function pdf(run:SavedRun) {
    if(run.kind!=='assessment' || !detail.current || busy)return
    setBusy(true)
    try{
      const {exportPdf}=await import('./export-view')
      await exportPdf({element:detail.current,topic:'已保存生态评估',station:run.report.scope.name,year:run.report.year ?? '台账基准',metric:run.report.scenario.name,
        rows:assessmentRows(run.report),method:run.report.method+'；'+run.report.modelCard.eeiRange,source:'已保存输入快照；SHA-256 '+run.id,url:run.viewUrl,run:run.report})
      setMessage('原始成果 PDF 已导出')
    }catch(error){setMessage(String((error as Error).message))}finally{setBusy(false)}
  }
  return <section className="workspace-sheet" aria-label={mode==='methods'?'数据与方法':'成果中心'}>
    <header className="sheet-heading"><div><span className="eyebrow">JINSHA · RESEARCH WORKSPACE</span><h2>{mode==='methods'?'数据与方法':'成果中心'}</h2>
      <p>{mode==='methods'?'先核对资料时效与适用范围，再解释生态结论。':'保存完整输入与结果；历史快照保留原数值，重新计算会生成独立运行。'}</p></div>
      {mode==='methods'?<button type="button" onClick={()=>void refresh()} disabled={busy || status?.collecting || status?.mode==='snapshot'}><RefreshCw size={16}/>{status?.collecting?'后台采集中…':'检查资料更新'}</button>:
        <label className="button-label"><Upload size={16}/>导入证据 JSON<input aria-label="导入证据 JSON" type="file" accept="application/json,.json" onChange={event=>{void importRun(event.target.files?.[0]);event.target.value=''}}/></label>}
    </header>
    {(message || error) && <p className="research-notice" role="status">{message || error}</p>}
    {mode==='methods'?<>
      <div className="source-status-grid">{status?.sources.map(source=><article className="source-status-card" key={source.id} data-state={source.state}>
        <div><h3>{source.label}</h3><strong>{freshnessNames[source.state]}</strong></div><p>{source.kind} · {source.version}</p>
        <dl><div><dt>最新观测</dt><dd>{source.observedAt ?? (source.kind==='模型预报'?'不适用':'尚无观测')}</dd></div>
          <div><dt>源起报时间</dt><dd>{dateTime(source.issuedAt)}</dd></div><div><dt>抓取时间</dt><dd>{dateTime(source.retrievedAt)}</dd></div>
          <div><dt>下次检查</dt><dd>{status?.mode==='snapshot'?'需重新发布静态快照':dateTime(source.nextCheckAt)}</dd></div>
          {source.validTo && <div><dt>预报有效至</dt><dd>{dateTime(source.validTo)}</dd></div>}
          {source.coverage && <div><dt>覆盖</dt><dd>{source.coverage.valid}/{source.coverage.total} {source.coverage.unit}</dd></div>}</dl>
        <p>{source.detail}</p><a href={source.sourceUrl} target="_blank" rel="noreferrer">来源与说明</a>
      </article>)}</div>
      <p className="research-notice">{status?.mode==='snapshot'?'本网站展示定时发布的离线资料快照；刷新网页不会更新源数据。':'采集由本机 Node 服务执行，关闭网页后继续；退出工作台服务或关闭电脑后停止。需要全天更新时须部署常驻采集节点。'} 实际传感器、水位、水质实时站网：未接入。</p>
      <article className="sheet-card"><h3>近期观测 · NOAA 逐站逐变量</h3><p>观测站与二十个研究站为不同站网。无自动空间映射；不据邻站数据改写研究站输入。</p>
        {observationError && <p role="alert">{observationError}</p>}
        {observations?<div className="research-table"><table><thead><tr><th>NOAA 站号 / 名称</th><th>最近日均温</th><th>最近降水</th><th>站内最新日期</th><th>采集 / 质量</th></tr></thead><tbody>{observations.stations.map(station=><tr key={station.id}>
          <td>{station.id}<small>{station.name} · {fmt(station.elevation)} m</small></td><td>{fmt(station.latest.TAVG?.value)} °C<small>{station.latest.TAVG?.date ?? '缺测'}</small></td>
          <td>{fmt(station.latest.PRCP?.value)} mm<small>{station.latest.PRCP?.date ?? '缺测'}</small></td><td>{station.observedAt ?? '缺测'}</td>
          <td>{station.error?'采集失败，保留旧值':station.observedAt && Date.now()-Date.parse(station.observedAt)<72*3_600_000?'近三日有资料':'源端延迟'}<small>近期质量排除 {station.qualityRejected} 项</small></td>
        </tr>)}</tbody></table></div>:<p>尚无近期采集快照。后台首次获取后可在这里核对。</p>}
      </article>
      <div className="method-columns"><article className="sheet-card"><h3>生态评估模型卡</h3>
        {report ? <><p><b>{report.modelCard.version}</b> · {report.modelCard.purpose}</p><p>{report.modelCard.eeiRange}</p><code className="formula">{report.modelCard.formula}</code>
          <p>{report.modelCard.gradeBasis}</p><dl>{Object.entries(report.modelCard.inputs).map(([key,value])=><div key={key}><dt>{{annual:'年度输入',fixed:'固定背景',validation:'校验与资料'}[key]}</dt><dd>{value}</dd></div>)}</dl>
          <p>{report.modelCard.domain}</p><p>{report.modelCard.validation}</p><p>{report.modelCard.standard}</p></>:<p>返回生态评估生成结果后查看完整方法卡。</p>}
      </article><article className="sheet-card"><h3>历史背景与解释资料</h3><p>年度气候与 NDVI 截至档案实际年份；RSEI 比较默认共同覆盖，无法覆盖的面积不参与改善结论。WorldCover 为 2021 年背景。</p>
        <p>CHIRPS v2 为已有降水档案，尚未接入 v3，不能将不同版本直接拼接为趋势。</p>
        <div className="research-module-links">{([['data','原始数据目录'],['water','生态水分 · 历史径流'],['engineering','工程影响资料'],['dispatch','公开调度事实'],['quality','水质报告'],['flood','历史洪水案例'],['emergency','白格历史案例'],['warning','研究核查优先级']] as [Scene,string][]).map(([scene,label])=><button key={scene} onClick={()=>onNavigate(scene)} type="button">{label}</button>)}</div>
      </article></div>
      {report && <details className="sheet-card"><summary>十八项指标的输入与解释</summary><div className="research-table"><table><thead><tr><th>指标 / 单位</th><th>输入变化类型</th><th>定义及限制</th></tr></thead><tbody>{report.metricDefinitions.map(metric=><tr key={metric.id}><td>{metric.name} · {metric.unit}</td><td>{metric.inputRole}</td><td>{metric.description}</td></tr>)}</tbody></table></div></details>}
      <details className="sheet-card"><summary>最近采集记录 · {status?.history.length ?? 0} 次</summary>{status?.history.map((entry,index)=><p key={index}>{dateTime(entry.at)} · {entry.source} · {entry.ok?'成功':'失败 / 部分失败'} · {entry.detail}</p>)}</details>
    </>:<div className="results-layout"><aside className="saved-run-list" aria-label="已保存成果">
      {runs.map(run=><button type="button" key={run.id} aria-pressed={selected?.id===run.id} onClick={()=>setSelectedId(run.id)}><FolderOpen size={18}/><span><b>{run.title}</b><small>{dateTime(run.savedAt)}</small></span></button>)}
      {!runs.length && <p>暂无保存的成果。先在生态评估或未来七天页面选择范围，再点击“保存成果”。也可以导入此前下载的完整证据 JSON。</p>}
    </aside>{selected && <div ref={detail} className="sheet-card result-detail"><span className="eyebrow">{selected.kind==='assessment'?'生态评估快照':'气象预报快照'}</span><h3>{selected.title}</h3>
      <p>保存时间 {dateTime(selected.savedAt)}</p><p className="run-hash">SHA-256 {selected.id}</p>
      {selected.kind==='assessment'?<><p>{selected.report.summary.spatialSupport}；有效 {selected.report.summary.count}/{selected.report.summary.eligible} 站。{selected.report.modelCard.eeiRange}</p>
        <dl>{assessmentRows(selected.report).map(([label,value,unit],index)=><div key={index}><dt>{label}</dt><dd>{value} <small>{unit}</small></dd></div>)}</dl>
      </>:<><p>抓取 {dateTime(selected.snapshot.retrievedAt)}；源起报时间未提供。</p><p>有效至 {dateTime(selected.snapshot.validTo)} · {forecastUsable(selected.snapshot)?'有效时段内':'该历史批次已失效'}</p><p>范围 {selected.selection.scope}；日期 {selected.selection.day || '完整七天'}；{selected.snapshot.stations.length} 个研究格点。</p><ul>{selected.snapshot.notes.map(note=><li key={note}>{note}</li>)}</ul></>}
      <div className="research-actions"><button type="button" onClick={()=>downloadText('金沙江-完整证据-'+selected.id.slice(0,12)+'.json',JSON.stringify(selected,null,2))}><Download size={15}/>完整证据 JSON</button>
        {selected.kind==='assessment' && <><button type="button" onClick={()=>downloadText('金沙江-站点-'+selected.id.slice(0,12)+'.csv',assessmentCsv(selected.report),'text/csv;charset=UTF-8')}>站点 CSV</button><button type="button" disabled={busy} onClick={()=>void pdf(selected)}>PDF 简报</button></>}
        <button type="button" onClick={()=>{window.location.search=new URL(selected.viewUrl,window.location.href).search}}>按原条件重新查看</button>
        <button type="button" onClick={()=>{removeRun(selected.id);setRuns(savedRuns());setSelectedId('')}}>移除本地副本</button></div>
      <p className="research-notice">成果保存在本浏览器，请下载 JSON 备份。JSON 的 SHA-256 用于完整性校验；科学有效性仍需依据原始资料和模型验证。重开原条件时会核对运行哈希，不以新数据覆盖此副本。</p>
    </div>}</div>}
  </section>
}
