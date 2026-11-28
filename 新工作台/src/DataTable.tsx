import { useMemo, useRef, useState, type ReactNode } from 'react'

export type TableColumn<T> = {
  key: string
  label: string
  value: (row: T) => string | number | null | undefined
  render?: (row: T) => ReactNode
  exportValue?: (row: T) => string | number | null | undefined
  numeric?: boolean
  sum?: boolean
}

function csvCell(value: unknown) {
  return '"' + String(value ?? '').replaceAll('"', '""') + '"'
}

export function DataTable<T>({ columns, rows, name, className = '', initialSort = null, exportLabel = '导出 CSV' }: {
  columns: TableColumn<T>[]; rows: T[]; name: string; className?: string; exportLabel?: string
  initialSort?: { key:string; descending:boolean } | null
}) {
  const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(initialSort)
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const ordered = useMemo(() => {
    const column = columns.find(item => item.key === sort?.key)
    if (!column) return rows
    return [...rows].sort((a, b) => {
      const left = column.value(a), right = column.value(b)
      if (left == null || left === '') return right == null || right === '' ? 0 : 1
      if (right == null || right === '') return -1
      const comparison = column.numeric ? Number(left) - Number(right) : String(left).localeCompare(String(right), 'zh-CN', { numeric: true })
      return comparison * (sort?.descending ? -1 : 1)
    })
  }, [columns, rows, sort])
  const virtual = ordered.length > 200
  const rowHeight = 34
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - 4) : 0
  const end = virtual ? Math.min(ordered.length, start + 22) : ordered.length
  const totals = columns.map(column => column.sum ? rows.reduce((sum, row) => {
    const value = Number(column.value(row))
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0) : null)

  function exportCsv() {
    const content = '\uFEFF' + [columns.map(column => csvCell(column.label)).join(','),
      ...ordered.map(row => columns.map(column => csvCell(column.exportValue ? column.exportValue(row) : column.value(row))).join(','))].join('\r\n')
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name + '.csv'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return <div className={'data-table '+className}>
    <div className={'data-table-scroll'+(virtual ? ' virtual' : '')} ref={scrollRef} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      <table><thead><tr>{columns.map(column => <th key={column.key} scope="col" className={column.numeric ? 'numeric' : undefined}
        aria-sort={sort?.key === column.key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
        <button type="button" onClick={() => { setSort(old => ({ key:column.key, descending:old?.key === column.key && !old.descending })); setScrollTop(0); if (scrollRef.current) scrollRef.current.scrollTop=0 }}>
          {column.label}<span aria-hidden="true">{sort?.key === column.key ? sort.descending ? ' ↓' : ' ↑' : ' ↕'}</span>
        </button></th>)}</tr></thead><tbody>
        {virtual && start > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height:start * rowHeight }}/></tr>}
        {ordered.slice(start, end).map((row, index) => <tr key={start + index}>{columns.map(column => <td key={column.key} className={column.numeric ? 'numeric' : undefined}>
          {column.render ? column.render(row) : column.value(row) ?? '—'}</td>)}</tr>)}
        {virtual && end < ordered.length && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height:(ordered.length - end) * rowHeight }}/></tr>}
      </tbody></table>
    </div>
    <div className="data-table-footer"><span>合计 {rows.length} 行{totals.map((value, index) => value === null ? '' : ` · ${columns[index].label} ${Number(value.toFixed(3)).toLocaleString('zh-CN')}`).join('')}</span>
      <button type="button" onClick={exportCsv} disabled={!rows.length}>{exportLabel}</button></div>
  </div>
}
