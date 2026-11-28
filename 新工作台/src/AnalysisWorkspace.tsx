import { useEffect,useId,useRef,useState,type ReactNode } from 'react'
import { Database,Download,Save,Settings2,X } from 'lucide-react'
import { useDialogFocus } from './dialog-focus'

export type AnalysisView='results'|'map'|'tools'
export function AnalysisWorkspace({tasks,context,summary,stations,trend,setup,results,tools,map,mapControls,view,onView,onSave,onExport,onMethods,pending,compact,stationEvidence}: {
  tasks:ReactNode;context:ReactNode;summary:ReactNode;stations:ReactNode;trend:ReactNode;setup:ReactNode;results:ReactNode;tools:ReactNode;map:ReactNode;mapControls:ReactNode;
  view:AnalysisView;onView:(view:AnalysisView)=>void;onSave:()=>void;onExport:(kind:'png'|'pdf')=>void;onMethods:()=>void;pending:boolean;compact:boolean
  stationEvidence?: { selection:string; content:ReactNode }
}) {
  const conditions=useRef<HTMLDialogElement>(null)
  const [inspectorOpen,setInspectorOpen]=useState(view!=='map')
  const [trendOpen,setTrendOpen]=useState(false)
  const panelTrigger=useRef<HTMLButtonElement|null>(null)
  function closeInspector() {setInspectorOpen(false);panelTrigger.current?.focus()}
  const [inspector,setInspector]=useState<HTMLElement|null>(null)
  useDialogFocus(inspector,compact && inspectorOpen,closeInspector)
  const modal=compact && inspectorOpen
  const evidenceId=useId()
  const evidenceSelection=stationEvidence?.selection
  const [expandedSelection,setExpandedSelection]=useState<string | null>(null)
  useEffect(()=>setExpandedSelection(null),[evidenceSelection])
  const evidenceOpen=inspectorOpen && view==='results' && expandedSelection===evidenceSelection
  const evidenceButton=evidenceSelection && <button type="button" aria-expanded={evidenceOpen} aria-controls={evidenceId} onClick={event=>{
    if (!modal) panelTrigger.current=event.currentTarget
    if (evidenceOpen) {
      setExpandedSelection(null)
      return
    }
    onView('results')
    setInspectorOpen(true)
    setExpandedSelection(evidenceSelection)
  }}>{evidenceOpen?'收起本站依据':'查看本站依据'}</button>

  return <section className="analysis-workspace" aria-label="生态评估工作区">
    <div className="analysis-context-bar" inert={modal}>
      <div className="analysis-conditions">{context}</div>
      <div className="analysis-deliver">
        <button type="button" onClick={()=>conditions.current?.showModal()}><Settings2 size={15}/>高级条件</button>
        <button type="button" className="primary-action" onClick={onSave}><Save size={15}/>保存成果</button>
        <button type="button" disabled={pending} onClick={()=>onExport('pdf')}><Download size={15}/>PDF 简报</button>
      </div>
    </div>
    <div className={'analysis-body'+(view==='results'?' detail-open':'')+(inspectorOpen?'':' inspector-collapsed')}>
      <aside className="analysis-task-rail" aria-label="分析任务" inert={modal}>{tasks}
        <button type="button" onClick={onMethods}><Database size={15}/>数据与方法</button>
      </aside>
      <div className="analysis-main" inert={modal}>
        <div className={'analysis-summary'+(stationEvidence?' analysis-summary-with-evidence':'')}>
          <div aria-live="polite">{summary}</div>
          {evidenceButton}
        </div>
        <nav className="output-navigation" aria-label="本次分析的结果视图">
          {([['map','站点列表'],['results','结果与证据'],['tools','智能体与修正']] as [AnalysisView,string][]).map(([id,label])=><button type="button" key={id} aria-pressed={view===id && inspectorOpen} aria-expanded={view===id && inspectorOpen} aria-controls="analysis-inspector" onClick={event=>{panelTrigger.current=event.currentTarget;onView(id);setInspectorOpen(view!==id || !inspectorOpen)}}>{label}</button>)}
          {trend && <button className="trend-toggle" type="button" aria-expanded={trendOpen} aria-controls="analysis-trend" onClick={()=>setTrendOpen(!trendOpen)}>{trendOpen?'收起趋势图':'展开趋势图'}</button>}
        </nav>
        <div className="analysis-map-view">
          <div className="analysis-map-toolbar">{mapControls}<button type="button" disabled={pending} onClick={()=>onExport('png')}>PNG</button></div>
          <div className="analysis-map-canvas">{map}</div>
        </div>
        {trend && <section id="analysis-trend" className="analysis-trend" aria-label="所选对象年度趋势" hidden={!trendOpen}>{trend}</section>}
      </div>
      {modal && <button type="button" className="inspector-scrim" aria-label="关闭对象面板遮罩" onClick={closeInspector}/>}
      <aside id="analysis-inspector" ref={setInspector} hidden={!inspectorOpen} className={'analysis-inspector'+(modal?' inspector-open':'')} aria-label={view==='map'?'研究站点':view==='results'?'结果与证据':'智能体与修正'}
        role={modal?'dialog':undefined} aria-modal={modal?true:undefined} inert={compact && !inspectorOpen}>
        <header className="inspector-heading"><h2>{view==='map'?'研究站点':view==='results'?'结果与证据':'智能体与修正'}</h2>
          {modal && view==='results' && evidenceButton}
          <button className="inspector-close" type="button" onClick={closeInspector} aria-label="收起右侧面板"><X size={17}/></button></header>
        <div className="inspector-content">
          {stationEvidence && <div id={evidenceId} className="station-evidence-detail" role="region" aria-label="本站评估依据" hidden={!evidenceOpen}>
            {evidenceOpen && stationEvidence.content}
          </div>}
          {view==='map'?stations:view==='results'?results:tools}
        </div>
      </aside>
    </div>
    <dialog ref={conditions} className="analysis-settings" aria-label="完整分析条件">
      <form method="dialog" className="settings-heading"><h2>分析条件</h2><button type="submit" aria-label="关闭分析条件"><X size={18}/></button></form>
      {setup}<p className="settings-note">条件修改后自动重算。保存成果保留本次输入、方法和结果。</p>
    </dialog>
  </section>
}
