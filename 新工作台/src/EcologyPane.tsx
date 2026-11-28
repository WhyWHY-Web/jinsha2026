import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Bot, Check, Download, LocateFixed, RotateCcw, Send } from 'lucide-react'
import type { Station, StationMark } from './data'
import { PanelHeader } from './PanelHeader'
import { useEcology } from './ecology-state'
import { assessmentCsv } from './assessment-export'
import { assessmentEvidence } from './saved-runs'
import { DataTable } from './DataTable'
import type {
  AgentAction, AgentReply, AmendmentDraft, AmendmentField, AmendmentHistory, AmendmentPreview,
  AssessmentReport, EcologyOptions, EcologyStation, MetricValues, RseiArchive, SoilArchive,
} from './ecology-types'
import './ecology.css'

const fieldNames: Record<AmendmentField, string> = { temperature:'年均气温', precipitation:'年降水量' }
const fieldUnits: Record<AmendmentField, string> = { temperature:'°C', precipitation:'mm' }
const noStations: Station[] = []
const promptSuggestions = ['评估当前区域生态状况', '定位石鼓站', '查看可用数据']
const usualMetrics = ['eei', 'risk', 'carbon', 'fvc']

function valueText(value: unknown, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits:digits }).format(value)
    : '—'
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json() as T & { error?: unknown }
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : '服务暂不可用（'+response.status+'）')
  return payload
}

function postJson<T>(url: string, body: unknown) {
  return getJson<T>(url, {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body),
  })
}

function useEcologyRequest<T>(url: string | null, version = 0) {
  const [result,setResult] = useState<{ url:string; version:number; data:T | null; error:string }>({ url:'', version:0, data:null, error:'' })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    getJson<T>(url, { signal:controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ url, version, data, error:'' }) })
      .catch(error => { if (!controller.signal.aborted) setResult({ url, version, data:null, error:String(error?.message ?? error) }) })
    return () => controller.abort()
  }, [url, version])
  const current = result.url === url && result.version === version
  return { data:current ? result.data : null, error:current ? result.error : '', loading:Boolean(url) && !current }
}

type EcologyState = ReturnType<typeof useEcology>
type PaneProps = {
  side: 'right' | 'setup' | 'results' | 'summary' | 'station-evidence'
  ecology: EcologyState
  stations?: Station[]
  onSelectStation: (id: string | null) => void
  onOpenData?: () => void
  taskControls?:ReactNode
}

function EcologyCard({ title, tag, children,className='' }: { title:string; tag?:string; children:ReactNode;className?:string }) {
  return <section className={'hud eco-card '+className}>
    <PanelHeader title={title} tag={tag}/>
    <div className="eco-content">{children}</div>
  </section>
}

function downloadReport(report: AssessmentReport) {
  downloadFile('金沙江生态评估-'+(report.year ?? '台账')+'.csv', assessmentCsv(report), 'text/csv;charset=UTF-8')
}

function downloadFile(name: string, content: string, type: string) {
  const address = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = address
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(address), 1000)
}

function AssessmentFilters({ ecology, stations, onSelectStation,taskControls }: Omit<PaneProps,'side' | 'onOpenData'>) {
  const [boundaryInput,setBoundaryInput] = useState(ecology.bbox)
  useEffect(()=>setBoundaryInput(ecology.bbox),[ecology.bbox])
  function chooseScope(value: string) {
    if (value.startsWith('station:')) onSelectStation(value.slice(8))
    else { ecology.setScope(value); onSelectStation(null) }
  }
  return <EcologyCard title="本次分析条件" tag="历史研究资料">
    {taskControls}
    <div className="eco-form">
      <label>评估区域<select aria-label="评估区域" value={ecology.activeScope} onChange={event=>chooseScope(event.target.value)}>
        {ecology.options ? ecology.options.regions.filter(region=>!region.id.startsWith('station:') && region.id!=='bbox').map(region=>
          <option key={region.id} value={region.id}>{region.name}{region.count > 0 ? ' · '+region.count+' 站' : ''}</option>
        ) : <option value="basin">金沙江流域</option>}
        <option value="bbox">自定义范围</option>
        <optgroup label="单站评估">{stations?.map(station => <option key={station.id} value={'station:'+station.id}>{station.name}</option>)}</optgroup>
      </select></label>
      {ecology.activeScope === 'bbox' && <form className="eco-inline" onSubmit={event=>{event.preventDefault(); ecology.setBbox(boundaryInput)}}>
        <label>最小经度、最小纬度、最大经度、最大纬度<input value={boundaryInput}
          onChange={event=>setBoundaryInput(event.target.value)} placeholder="98,26,103,31"
          pattern="\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*" required/></label>
        <button type="submit">应用</button>
      </form>}
        <label>评估年份<select aria-label="评估年份" value={ecology.year} onChange={event=>ecology.setYear(event.target.value)}>
          <option value="">台账基准</option>{ecology.options?.years.slice().reverse().map(year=><option key={year} value={year}>{year}</option>)}
        </select></label>
      <details className="ecology-advanced" open={ecology.compareYear || ecology.scenario!=='baseline' ? true : undefined}><summary>对照与敏感性条件</summary><div className="eco-form">
        <label>对照年份<select aria-label="对照年份" value={ecology.compareYear} onChange={event=>ecology.setCompareYear(event.target.value)}>
          <option value="">关闭</option>{ecology.options?.years.slice().reverse().map(year=><option key={year} value={year}>{year}</option>)}
        </select></label>
      <label>评估情景<select aria-label="评估情景" value={ecology.scenario} onChange={event=>ecology.setScenario(event.target.value)}>
        {(ecology.options?.scenarios ?? [{ id:'baseline', name:'基准情景' }]).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      </div></details>
      {ecology.report?.scenario.id !== 'baseline' && ecology.report?.scenario.description && <p className="eco-note">{ecology.report.scenario.description}</p>}
      <button type="button" className="eco-primary" onClick={ecology.refresh} disabled={ecology.loading}>生成 / 刷新评估</button>
      <p className="eco-note">选择条件后自动重算。年度输入截至档案可用年份；经验情景属于敏感性分析。</p>
      {ecology.error && <div className="eco-error" role="alert">{ecology.error} <button type="button" onClick={ecology.refresh}>重试</button></div>}
      {ecology.loading && <p className="eco-note" role="status">正在计算所选区域…</p>}
    </div>
  </EcologyCard>
}

function IndexRows({ report, values }: { report:AssessmentReport; values:MetricValues }) {
  const [expanded,setExpanded] = useState(false)
  const metrics = expanded ? report.metricDefinitions : report.metricDefinitions.filter(item => usualMetrics.includes(item.id))
  return <>
    <dl className="eco-metrics">
      {metrics.map(item => <div key={item.id} title={item.description}><dt>{item.name}</dt>
        <dd>{valueText(values[item.id], item.id === 'fvc' ? 3 : 1)} <small>{item.unit}</small>
          {report.comparison?.delta && typeof report.comparison.delta[item.id] === 'number' && <small className="eco-delta">
            {report.comparison.delta[item.id]! > 0 ? '+' : ''}{valueText(report.comparison.delta[item.id],2)}
          </small>}
        </dd></div>)}
    </dl>
    <button className="eco-text-button" type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      {expanded ? '收起分量' : '查看全部分量'}
    </button>
  </>
}

function AssessmentResults({ report, onSelectStation }: { report:AssessmentReport; onSelectStation:PaneProps['onSelectStation'] }) {
  const means=report.comparison?.currentMeans ?? report.summary.means
  const changes = ['eei','risk','carbon'].flatMap(id => {
    const deltas = report.stations.map(station=>station.delta[id]).filter((value): value is number => typeof value==='number')
    const metric = report.metricDefinitions.find(item=>item.id===id)
    return metric && deltas.length > 0 ? [{ metric, value:deltas.reduce((sum,value)=>sum+value,0)/deltas.length }] : []
  })
  return <>
    <EcologyCard title={report.scope.name+' · 评估结果'} tag={report.summary.count+' / '+report.summary.eligible+' 站'} className="assessment-summary">
      {report.summary.means ? <>
        <div className="eco-hero">
          <div><span>生态环境综合指数</span><strong>{valueText(means?.eei)}</strong></div>
          <div><span>复合风险筛查</span><strong>{valueText(means?.risk)}</strong></div>
          <div><span>植被碳密度估算 · tC/ha</span><strong>{valueText(means?.carbon)}</strong></div>
          <div><span>植被覆盖代理 · 比例</span><strong>{valueText(means?.fvc,3)}</strong></div>
        </div>
        <p className="eco-note">有效 {report.summary.count}/{report.summary.eligible} 站 · 站点等权均值，非流域面积统计。{report.scope.kind==='basin' && `${report.summary.sampledBasins}/${report.summary.totalBasins} 个子流域有纳入站点。`}</p>
        <p className="eco-note">EEI 为经验分，无固定 100 分上限；项目经验等级未作国家标准认证。</p>
        {report.comparison && <p className="eco-note">与 {report.comparison.year} 年对照，纳入 {report.comparison.count} 站。</p>}
        {report.scenario.id !== 'baseline' && changes.length > 0 && <details className="eco-details" open>
          <summary>与同年基准比较</summary>
          <dl className="eco-metrics">{changes.map(({metric,value})=><div key={metric.id}><dt>{metric.name}</dt>
            <dd>{value > 0 ? '+' : ''}{valueText(value,2)} <small>{metric.unit}</small></dd></div>)}</dl>
        </details>}
        <details className="eco-details metric-details"><summary>查看指标分量与两期差值</summary><IndexRows report={report} values={means ?? {}}/></details>
        <div className="eco-exports">
          <button className="eco-download" onClick={()=>downloadReport(report)} type="button"><Download size={14}/> 站点 CSV</button>
          <button className="eco-download" onClick={()=>downloadFile('金沙江-评估证据-'+(report.year ?? '台账')+'.json',
            JSON.stringify(assessmentEvidence(report,window.location.href),null,2),'application/json;charset=UTF-8')} type="button">完整证据 JSON</button>
        </div>
      </> : <p className="eco-note" role="status">该范围暂无满足评估条件的站点，不能据此判为低风险。子流域可在右侧“遥感与土壤资料”检查有效覆盖，或改选有站范围。</p>}
      <p className="eco-note">运行 {report.run.id} · {report.method}</p>
    </EcologyCard>
    {report.stations.length > 1 && <EcologyCard title="站点明细与核查" tag={report.stations.length+' 站'} className="assessment-station-table">
      <DataTable name="本次评估站点" rows={report.stations} initialSort={{key:'eei',descending:true}} columns={[
        {key:'name',label:'研究站点',value:row=>row.name,render:row=><button type="button" onClick={()=>onSelectStation(row.id)}><LocateFixed size={13}/>{row.name}</button>},
        {key:'eei',label:'EEI 经验分',value:row=>row.metrics.eei,numeric:true},
        {key:'risk',label:'敏感性',value:row=>row.metrics.risk,numeric:true},
        {key:'grade',label:'经验分组',value:row=>row.grade},
        {key:'ndvi',label:'年度 NDVI',value:row=>row.ndvi,numeric:true},
      ]}/>
    </EcologyCard>}
    <EcologyCard title="方法与质量" className="assessment-method">
      <p className="eco-note">{typeof report.method === 'string' ? report.method : '站点生态评估'}</p>
      <ul className="eco-evidence">{report.quality.notes.map(note=><li key={note}>{note}</li>)}</ul>
      {Boolean(report.quality.missingStations.length) && <p className="eco-note">缺测站点 {report.quality.missingStations.join('、')}</p>}
      {Boolean(report.quality.anomalies.length) && <details className="eco-details">
        <summary>需要核查 · {report.quality.anomalies.length} 项</summary>
        <ul className="eco-evidence">{report.quality.anomalies.map(row=><li key={row.stationId+'-'+row.field}>
          <b>{row.station} · {row.name} · {row.level}</b>
          <span>现值 {valueText(row.value,2)} {row.unit}，邻站参考 {valueText(row.reference,2)} {row.unit}</span>
          <span>最近参考距离 {valueText(row.nearestKm)} km，高差 {valueText(row.elevationDifferenceM,0)} m。</span>
          <span>{row.note}</span>
          <button type="button" onClick={()=>onSelectStation(row.stationId)}>定位站点</button>
        </li>)}</ul>
      </details>}
    </EcologyCard>
  </>
}

function safeEvidenceLink(value?: string) {
  if (value?.startsWith('https://')) return value
  if (value?.startsWith('/api/') && document.documentElement.dataset.jinshaMode !== 'public') return value
}

function ResearchAgent({ ecology, onAction, canAmend }: { ecology:EcologyState; onAction:(action:AgentAction)=>void; canAmend:boolean }) {
  const [prompt,setPrompt] = useState('')
  const [pending,setPending] = useState(false)
  const [interactions,setInteractions] = useState<{ prompt:string; reply:AgentReply }[]>([])
  const [error,setError] = useState('')
  const last = interactions.at(-1)
  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const question = prompt.trim()
    if (!question || pending) return
    setPending(true)
    setError('')
    try {
      const reply = await postJson<AgentReply>('/api/ecology/agent', {
        prompt:question, stationId:ecology.selectedStationId ?? undefined,
        scope:ecology.activeScope, year:ecology.year ? Number(ecology.year) : undefined,
        ledger:!ecology.year,scenario:ecology.scenario,compareYear:ecology.compareYear?Number(ecology.compareYear):undefined,
        bbox:ecology.activeScope === 'bbox' ? ecology.bbox : undefined,
      })
      setInteractions(current=>[...current.slice(-4), { prompt:question, reply }])
      setPrompt('')
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)) }
    finally { setPending(false) }
  }
  const actionLabel = last?.reply.action && (canAmend || last.reply.action.type!=='draftAmendment') && {
    showStation:'在地图定位', showAssessment:'查看对应评估', showData:'打开数据资源', draftAmendment:'填写修正草稿',
  }[last.reply.action.type]
  return <EcologyCard title="生态智能体" tag={last?.reply.mode === 'ollama' ? '本地语言模型' : '本地工具'}>
    <form className="eco-form" onSubmit={ask}>
      <label><span className="eco-agent-label"><Bot size={15}/> 生态问题</span>
        <textarea value={prompt} onChange={event=>setPrompt(event.target.value)} maxLength={700} rows={2} placeholder="例如，定位石鼓并查看生态评估" required/>
      </label>
      <div className="eco-suggestions">{promptSuggestions.map(suggestion=>
        <button key={suggestion} type="button" onClick={()=>setPrompt(suggestion)}>{suggestion}</button>
      )}</div>
      <button className="eco-primary" type="submit" disabled={pending || !prompt.trim()}><Send size={13}/> {pending ? '查询中…' : '发送'}</button>
    </form>
    {error && <p className="eco-error" role="alert">{error}</p>}
    {last && <div className="eco-answer" aria-live="polite">
      <p className="eco-question">{last.prompt}</p><p>{last.reply.answer}</p>
      {last.reply.evidence.length > 0 && <ul className="eco-evidence">{last.reply.evidence.map((item,index) => {
        const href = safeEvidenceLink(item.url)
        return <li key={index}>{href ? <a href={href} target="_blank" rel="noreferrer">{item.label}</a> : <b>{item.label}</b>}<span>{item.detail}</span></li>
      })}</ul>}
      {actionLabel && <button className="eco-primary" type="button" onClick={()=>onAction(last.reply.action!)}>{actionLabel}</button>}
    </div>}
    {interactions.length > 1 && <details className="eco-details"><summary>最近对话</summary>
      {interactions.slice(0,-1).reverse().map((turn,index)=><div key={index}><b>{turn.prompt}</b><p>{turn.reply.answer}</p></div>)}
    </details>}
  </EcologyCard>
}

type DraftValues = Omit<AmendmentDraft,'value' | 'year'> & { value:string; year:string }
type EditorPreset = { field?:AmendmentField; value?:number; year?:number; stationId?:string }
type SavedPreview = { draft:AmendmentDraft; state:AmendmentPreview }

function RegionAmendment({ stations, ecology, preset, afterWrite }: {
  stations: Station[]; ecology:EcologyState; preset:EditorPreset | null; afterWrite:()=>void;
}) {
  const [draft,setDraft] = useState<DraftValues>({
    stationIds:preset?.stationId ? [preset.stationId] : ecology.selectedStationId ? [ecology.selectedStationId] : [],
    field:preset?.field ?? 'precipitation', year:String(preset?.year ?? (ecology.year || ecology.options?.years.at(-1) || '')),
    value:preset?.value == null ? '' : String(preset.value), source:'', reason:'',
  })
  const [history,setHistory] = useState<AmendmentHistory | null>(null)
  const [preview,setPreview] = useState<SavedPreview | null>(null)
  const [busy,setBusy] = useState(false)
  const [notice,setNotice] = useState('')
  const [error,setError] = useState('')
  const assessmentStations = ecology.report?.stations.map(station=>station.id) ?? []
  useEffect(() => {
    const controller = new AbortController()
    getJson<AmendmentHistory>('/api/ecology/amendments', { signal:controller.signal })
      .then(data=>{ if (!controller.signal.aborted) setHistory(data) })
      .catch(problem=>{ if (!controller.signal.aborted) setError(String(problem?.message ?? problem)) })
    return () => controller.abort()
  }, [])
  function update(item: Partial<DraftValues>) {
    setPreview(null)
    setNotice('')
    setError('')
    setDraft(current=>({...current,...item}))
  }
  async function previewEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    setPreview(null)
    const request = { ...draft, year:Number(draft.year), value:Number(draft.value), source:draft.source.trim(), reason:draft.reason.trim() }
    try { setPreview({ draft:request, state:await postJson<AmendmentPreview>('/api/ecology/amendments/preview',request) }) }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)) }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await postJson<AmendmentHistory>('/api/ecology/amendments', { ...preview.draft, revision:preview.state.revision })
      setHistory(response)
      setNotice('已记录修正，评估正在刷新。')
      setPreview(null)
      afterWrite()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
      setPreview(null)
    } finally { setBusy(false) }
  }
  async function revert(id: number) {
    if (busy) return
    setBusy(true)
    setPreview(null)
    setError('')
    try {
      const latest = await getJson<AmendmentHistory>('/api/ecology/amendments')
      const response = await postJson<AmendmentHistory>('/api/ecology/amendments/'+id+'/revert', { revision:latest.revision })
      setHistory(response)
      setNotice('已撤销修正。')
      afterWrite()
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)) }
    finally { setBusy(false) }
  }
  return <>
    <form className="eco-form" onSubmit={previewEdit}>
      <fieldset disabled={busy}>
        <legend>应用站点 · 已选 {draft.stationIds.length}</legend>
        {assessmentStations.length > 0 && <button type="button" className="eco-text-button" onClick={()=>update({ stationIds:assessmentStations })}>选中当前评估区域的站点</button>}
        <div className="eco-checklist">
          {stations.map(station=><label key={station.id}><input type="checkbox" checked={draft.stationIds.includes(station.id)}
            onChange={event=>update({ stationIds:event.target.checked ? [...draft.stationIds,station.id] : draft.stationIds.filter(id=>id!==station.id) })}/>
            {station.name}</label>)}
        </div>
      </fieldset>
      <div className="eco-cols">
        <label>修正指标<select aria-label="修正指标" value={draft.field} disabled={busy} onChange={event=>update({ field:event.target.value as AmendmentField })}>
          {Object.entries(fieldNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>档案年份<select value={draft.year} disabled={busy} required onChange={event=>update({year:event.target.value})}>
          {ecology.options?.years.slice().reverse().map(year=><option key={year} value={year}>{year}</option>)}</select></label>
      </div>
      <label>修正值（{fieldUnits[draft.field]}）<input type="number" step="any" min={draft.field==='temperature' ? -65 : 0}
        max={draft.field==='temperature' ? 60 : 12000} value={draft.value} disabled={busy}
        required onChange={event=>update({ value:event.target.value })}/></label>
      <label>来源<input value={draft.source} disabled={busy} maxLength={300} required onChange={event=>update({ source:event.target.value })}/></label>
      <label>修正理由<textarea rows={2} value={draft.reason} disabled={busy} maxLength={600} required onChange={event=>update({ reason:event.target.value })}/></label>
      <button type="submit" className="eco-primary" disabled={!draft.stationIds.length || busy}>预览修正</button>
    </form>
    {preview && <div className="eco-preview">
      <b>{preview.state.count} 个站点 · {preview.draft.year} 年 {fieldNames[preview.draft.field]}</b>
      <ul className="eco-evidence">{preview.state.previous.map(item=><li key={item.stationId}>
        {item.name} · {valueText(item.value,2)} → {valueText(preview.draft.value,2)} {fieldUnits[preview.draft.field]}
      </li>)}</ul>
      <button className="eco-primary" type="button" disabled={busy} onClick={confirm}><Check size={14}/> 确认写入</button>
    </div>}
    {error && <p className="eco-error" role="alert">{error}</p>}
    {notice && <p className="eco-notice" role="status">{notice}</p>}
    {history?.entries.length ? <details className="eco-details">
      <summary>修正历史 · {history.entries.length}</summary>
      <ul className="eco-evidence">{history.entries.slice().sort((a,b)=>b.id-a.id).map(entry=><li key={entry.id}>
        <b>{entry.year} 年 · {fieldNames[entry.field]} · {valueText(entry.value,2)} {fieldUnits[entry.field]}</b>
        <span>{entry.stationIds.map(id=>stations.find(station=>station.id===id)?.name ?? id).join('、')}</span>
        <span>{entry.source} · {entry.reason}</span>
        {entry.reverted ? <small>已撤销</small> : <button type="button" className="eco-text-button" disabled={busy}
          onClick={()=>revert(entry.id)}><RotateCcw size={12}/> 撤销此记录</button>}
      </li>)}</ul>
    </details> : null}
  </>
}

function StationEvidence({ station,year }: { station:EcologyStation; year?:number | null }) {
  const { inputs } = station
  return <EcologyCard title={station.name+' · 评估依据'} tag={station.grade}>
    <p className="eco-note">{year !== undefined && (year === null ? '台账基准 · ' : year+' 年 · ')}{station.zone} · {station.riskLevel}</p>
    <dl className="eco-metrics">
      <div><dt>经度</dt><dd>{valueText(station.lon,4)}°</dd></div>
      <div><dt>纬度</dt><dd>{valueText(station.lat,4)}°</dd></div>
      <div><dt>NDVI</dt><dd>{valueText(station.ndvi,3)}</dd></div>
      <div><dt>年均气温</dt><dd>{valueText(inputs.temp,1)} °C</dd></div>
      <div><dt>年降水量</dt><dd>{valueText(inputs.precip)} mm</dd></div>
      <div><dt>坡度</dt><dd>{valueText(inputs.slope)}°</dd></div>
    </dl>
    <p className="eco-note">{inputs.climateSource} · {inputs.coverSource}</p>
    {inputs.amendedFields.length > 0 && <p className="eco-note">此评估使用了记录在修正历史中的输入。</p>}
  </EcologyCard>
}

function RseiEvidence({ ecology, basin }: { ecology:EcologyState; basin:string | null }) {
  const endpoint = '/api/ecology/rsei'+(basin ? '?scope='+encodeURIComponent('subbasin:'+basin) : '')
  const { data, error, loading } = useEcologyRequest<RseiArchive>(endpoint)
  const common=ecology.rseiMask==='common'
  const setCommon=(value:boolean)=>ecology.setRseiMask(value?'common':'annual')
  const compareYear=ecology.compareYear
  const setCompareYear=ecology.setCompareYear
  const record = data?.records.find(item=>item.year === Number(ecology.rseiYear)) ?? data?.records.at(-1)
  const region = data?.research?.region
  const annual = region?.records.find(item=>item.year===record?.year)
  const summary = common ? annual?.allYearsCommon : annual
  const comparison = region?.pairs.find(item => item.startYear===Number(compareYear) && item.endYear===record?.year)
  return <div className="eco-research-panel">
    <h3>遥感生态指数 RSEI</h3>
    {loading && <p className="eco-note" role="status">读取 Landsat 档案…</p>}
    {error && <p className="eco-error" role="alert">{error}</p>}
    {record && data && <>
      <p className="eco-note">{data.source} · {basin ? '所选子流域' : '全流域'}</p>
      {region && <div className="eco-switches">
        <label><input type="checkbox" checked={ecology.rseiLayer} onChange={event=>{
          if (event.target.checked && !ecology.rseiYear) ecology.setRseiYear(String(record.year))
          ecology.setRseiLayer(event.target.checked)
        }}/> 地图显示{common?'八期共同覆盖':'当期有效覆盖'} RSEI</label>
        <label><input type="checkbox" checked={common} onChange={event=>setCommon(event.target.checked)}/> 统计使用八期共同掩膜</label>
      </div>}
      <div className="eco-rsei-years" aria-label="遥感档案年份">
        {data.records.map(item=>{
          const local = region?.records.find(r=>r.year===item.year)
          const value = region ? (common ? local?.allYearsCommon.value : local?.value) : item.value
          return <button type="button" key={item.year} onClick={()=>{ecology.setRseiYear(String(item.year));setCompareYear('')}}
            aria-pressed={record.year===item.year} title={String(item.year)+' RSEI '+valueText(value,3)}>
            <span style={{ '--rsei-height':value == null ? '0%' : Math.max(4,value*100)+'%' } as CSSProperties}/>
            <small>{item.year}</small>
          </button>
        })}
      </div>
      <dl className="eco-metrics">
        <div><dt>{record.year} 年 RSEI</dt><dd>{valueText(region ? summary?.value : record.value,3)}</dd></div>
        <div><dt>传感器 / 影像量</dt><dd>{record.sensor} / {record.scenes}</dd></div>
        <div><dt>{common && region ? '共同有效覆盖' : '当期有效覆盖'}</dt><dd>{valueText(region ? summary?.coverageKm2 : record.coverageKm2,0)} km²</dd></div>
        {region && <div><dt>所选边界有效面积占比</dt><dd>{valueText((summary?.coverageKm2 ?? 0)/region.areaKm2*100,2)}%</dd></div>}
        {annual && <div><dt>当期口径待核零值</dt><dd>{valueText(annual.ambiguousZeroPixels,0)} 像元</dd></div>}
      </dl>
      {region && <div className="eco-form"><label>两期共同覆盖对照
        <select aria-label="两期共同覆盖对照" value={compareYear} onChange={event=>setCompareYear(event.target.value)}>
          <option value="">选择基准年</option>{region.pairs.filter(item=>item.endYear===record.year).map(item=>
            <option key={item.startYear} value={item.startYear}>{item.startYear}</option>)}
        </select>
      </label></div>}
      {comparison && <dl className="eco-metrics">
        <div><dt>共同覆盖面积</dt><dd>{valueText(comparison.coverageKm2,0)} km²</dd></div>
        <div><dt>RSEI 两期变化</dt><dd>{valueText(comparison.startValue,3)} → {valueText(comparison.endValue,3)}</dd></div>
        <div><dt>差值</dt><dd>{valueText(comparison.delta,3)}</dd></div>
      </dl>}
      <details className="eco-details"><summary>处理口径</summary>
        {data.research && <p className="eco-note">{data.research.version} · {data.research.crs} · {data.research.note}</p>}
        <p className="eco-note">以下四分量及载荷取自全流域原始档案。</p>
        <dl className="eco-metrics">{Object.entries(record.components).map(([key,value])=><div key={key}><dt>{key.toUpperCase()} 分量</dt><dd>{valueText(value,3)}</dd></div>)}</dl>
        <dl className="eco-metrics">{Object.entries(record.loadings).map(([key,value])=><div key={key}><dt>PC1 · {key.toUpperCase()}</dt><dd>{valueText(value,4)}</dd></div>)}</dl>
        <ul className="eco-evidence">{data.notes.map(note=><li key={note}>{note}</li>)}</ul>
        <button type="button" onClick={()=>downloadFile('金沙江-RSEI-'+(basin ?? '全流域')+'.json',
          JSON.stringify({selection:{scope:ecology.activeScope,year:record.year,compareYear,mask:common?'all-years-common':'per-year'},selectedStatistics:summary,pair:comparison ?? null,archive:data},null,2), 'application/json;charset=UTF-8')}>导出 RSEI 数据和来源 JSON</button>
      </details>
    </>}
  </div>
}

function SoilEvidence({ basin }: { basin: string | null }) {
  const { data, error, loading } = useEcologyRequest<SoilArchive>('/api/scientific'+(basin ? '?basin='+encodeURIComponent(basin) : ''))
  const [depth,setDepth] = useState('')
  const profile = data?.profiles.find(item=>item.depth === depth) ?? data?.profiles[0]
  return <div className="eco-research-panel">
    <h3>土壤剖面</h3>
    {loading && <p className="eco-note" role="status">读取土壤归档…</p>}
    {error && <p className="eco-error" role="alert">{error}</p>}
    {data && (profile ? <>
      <p className="eco-note">{data.archive.source} · {basin ? '所选子流域' : '全流域'}</p>
      <div className="eco-form"><label>土层深度<select aria-label="土层深度" value={profile.depth} onChange={event=>setDepth(event.target.value)}>
        {data.profiles.map(item=><option key={item.depth} value={item.depth}>{item.depth.replace(/cm$/,' cm')}</option>)}
      </select></label></div>
      <dl className="eco-metrics">
        <div><dt>有效样本 / 栅格</dt><dd>{valueText(profile.samples,0)} / {valueText(profile.inside,0)}</dd></div>
        {data.archive.fields.map(({field,label,unit})=><div key={field}><dt>{label}均值</dt>
          <dd>{valueText(profile.properties[field]?.mean,2)} <small>{unit}</small></dd></div>)}
      </dl>
      <p className="eco-note">格网模型估算，用于研究参考。</p>
    </> : <p className="eco-note">该范围暂无可用剖面。</p>)}
  </div>
}

function ResearchEvidence({ ecology,initialOpen=false }: { ecology:EcologyState;initialOpen?:boolean }) {
  const [opened,setOpened] = useState(initialOpen)
  const basin = ecology.activeScope.startsWith('subbasin:') ? ecology.activeScope.slice('subbasin:'.length) : null
  return <EcologyCard title="遥感与土壤证据" className="assessment-research">
    <button type="button" className="eco-text-button" aria-expanded={opened} onClick={()=>setOpened(!opened)}>
      {opened ? '收起档案' : '查看遥感与土壤档案'}
    </button>
    {opened && <>{(ecology.activeScope==='basin' || basin)?<><RseiEvidence ecology={ecology} basin={basin}/><SoilEvidence basin={basin}/></>:<p className="eco-note">遥感面积统计目前仅支持全流域或指定水文子流域。当前站点/框选不以全流域结果替代，请选择子流域后查看。</p>}</>}
  </EcologyCard>
}

export function EcologyPane({ side, ecology, stations = noStations, onSelectStation, onOpenData,taskControls }: PaneProps) {
  const canAmend = document.documentElement.dataset.jinshaMode !== 'public'
  const [editOpen,setEditOpen] = useState(false)
  const [preset,setPreset] = useState<EditorPreset | null>(null)
  const [editVersion,setEditVersion] = useState(0)
  function applyAction(action: AgentAction) {
    if (action.type === 'showData') { onOpenData?.(); return }
    if (action.stationId && stations.some(station=>station.id===action.stationId)) onSelectStation(action.stationId)
    else if (action.type === 'showAssessment' && action.scope &&
      (action.scope==='basin' || ecology.options?.regions.some(region=>region.id===action.scope))) {
      ecology.setScope(action.scope)
      onSelectStation(null)
    }
    if (action.year != null) ecology.setYear(String(action.year))
    if (action.type === 'draftAmendment' && canAmend) {
      setPreset(action)
      setEditVersion(current=>current+1)
      setEditOpen(true)
    }
  }
  if(side==='summary') {
    const report=ecology.report,means=report?.comparison?.currentMeans ?? report?.summary.means
    return <div className="workspace-summary">
      {ecology.loading ? <p role="status">正在计算当前条件…</p> : ecology.error ? <p role="alert">{ecology.error}</p> : report && <>
        <div className="workspace-metrics">{(['eei','risk','carbon','fvc'] as const).map(id=><div key={id}><span>{report.metricDefinitions.find(item=>item.id===id)?.name ?? id}</span><strong>{valueText(means?.[id],id==='fvc'?3:1)}</strong><small>{report.metricDefinitions.find(item=>item.id===id)?.unit}{report.comparison?.delta?.[id]!=null && ` · 对照差值 ${report.comparison.delta[id]!>0?'+':''}${valueText(report.comparison.delta[id],2)}`}</small></div>)}</div>
        <p>{report.scope.name} · {report.year ?? '台账基准'} · {report.scenario.name} · 有效 {report.summary.count}/{report.summary.eligible} 站 · 站点等权，非面积统计 · EEI 经验分无固定上限{report.comparison && ` · ${report.comparison.year} 年共同样本 ${report.comparison.count} 站`}</p>
      </>}
    </div>
  }
  if(side==='station-evidence') {
    const { selectedStationId,activeScope,report,loading } = ecology
    const year=ecology.year ? Number(ecology.year) : null
    const station=report?.run.parameters.scope===activeScope && report.year===year
      ? report.stations.find(item=>item.id===selectedStationId)
      : undefined
    if(station)return <StationEvidence station={station} year={year}/>
    const message=!selectedStationId ? '请选择一个站点后查看本站依据。'
      : loading ? '正在读取本站依据…' : '当前站点在所选年份暂无可用依据。'
    return <p className="eco-note" role="status">{message}</p>
  }
  if(side==='setup')return <AssessmentFilters ecology={ecology} stations={stations} onSelectStation={onSelectStation}/>
  if(side==='results')return <>
    {ecology.loading && <p className="research-notice" role="status">正在计算当前条件，请稍候…</p>}
    {ecology.error && <p className="research-error" role="alert">{ecology.error}</p>}
    {ecology.report && <AssessmentResults report={ecology.report} onSelectStation={onSelectStation}/>}
    <ResearchEvidence ecology={ecology} initialOpen/>
  </>
  const focused = ecology.report?.stations.find(station=>station.id===ecology.selectedStationId)
  return <>
    <ResearchEvidence ecology={ecology}/>
    {focused && <StationEvidence station={focused}/>}
    <ResearchAgent ecology={ecology} onAction={applyAction} canAmend={canAmend}/>
    <EcologyCard title="区域数据修正">
      {canAmend ? <>
        <button className="eco-text-button" type="button" onClick={()=>setEditOpen(!editOpen)} aria-expanded={editOpen}>{editOpen ? '收起修正表单' : '打开修正与历史'}</button>
        {editOpen && <RegionAmendment key={editVersion} ecology={ecology} stations={stations} preset={preset} afterWrite={ecology.refresh}/>}
      </> : <p className="eco-note">数据修正请使用桌面版。</p>}
    </EcologyCard>
  </>
}
