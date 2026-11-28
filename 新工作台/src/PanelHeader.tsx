import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

type PanelState = 'loading' | 'empty' | 'error'

const stateLabels: Record<PanelState, string> = {
  loading: '加载中…', empty: '暂无数据', error: '读取失败',
}

export function PanelHeader({ title, tag, actions, state }: {
  title: ReactNode
  tag?: ReactNode
  actions?: ReactNode
  state?: PanelState
}) {
  const [expanded,setExpanded] = useState(false)
  return <header className="panel-title">
    <h2>{title}</h2>
    <div className="panel-header-meta">
      {state && <span className={'panel-header-state '+state} role="status">{stateLabels[state]}</span>}
      {tag && <span className="panel-header-tag">{tag}</span>}
      {actions && <div className="panel-header-actions">{actions}</div>}
      <button className="panel-collapse-toggle" type="button" aria-label={(expanded ? '收起' : '展开')+String(title)} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><ChevronRight size={13}/></button>
    </div>
  </header>
}
