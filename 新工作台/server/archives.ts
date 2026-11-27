import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'

const directories = ['ghcn', 'precipitation', 'landcover', 'scientific']

type Archive = {
  id: string; label: string; source: string; kind: string; rows: number; file: string;
  unit?: string; description?: string; startYear?: number; endYear?: number; licenseUrl?: string; sourceUrl?: string
}

async function sources(root: string) {
  const archives = await Promise.all(directories.map(async directory => {
    const folder = join(root, directory)
    try {
      const manifest: Archive = JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'))
      if (!/^[a-z0-9_-]+$/i.test(manifest.id) || !manifest.file || basename(manifest.file)!==manifest.file || !manifest.file.endsWith('.csv.gz')) return null
      const path = join(folder,manifest.file)
      if (!(await stat(path)).isFile()) return null
      return { manifest, path }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }))
  return archives.filter(archive => archive !== null)
}

export async function archiveCatalog(root: string) {
  return (await sources(root)).map(({manifest}) => ({...manifest, unit: manifest.unit ?? '条', queryable:true}))
}

function csvRow(line: string): string[] {
  const fields: string[] = []
  let value = '', quoted = false
  for (let index=0; index<line.length; index++) {
    const next = line[index]
    if (next === '"') {
      if (quoted && line[index+1] === '"') { value += '"'; index++ }
      else quoted = !quoted
    } else if (next === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else value += next
  }
  fields.push(value)
  return fields
}

export async function readArchive(root: string, id: string, filter: {
  query: string; year?: string; limit: number; offset: number
}) {
  const archive = (await sources(root)).find(({manifest})=>manifest.id===id)
  if (!archive) return null
  const input = createReadStream(archive.path)
  const decoded = createGunzip()
  input.on('error', error => decoded.destroy(error))
  input.pipe(decoded)
  const rows = createInterface({ input:decoded, crlfDelay:Infinity })
  try {
    let columns: string[] = []
    let dateIndex = -1, matched = 0, hasMore = false
    const result: string[][] = []
    for await (const line of rows) {
      if (!columns.length) {
        columns = csvRow(line.replace(/^\uFEFF/,''))
        dateIndex = columns.findIndex(column => ['year','date','month'].includes(column.toLowerCase()))
        continue
      }
      if (!line || filter.query && !line.toLowerCase().includes(filter.query)) continue
      const record = csvRow(line)
      if (record.length !== columns.length) continue
      if (filter.year && dateIndex >= 0 && record[dateIndex].slice(0,4)!==filter.year) continue
      if (filter.year && dateIndex < 0 && String(archive.manifest.startYear)!==filter.year) continue
      if (matched++ < filter.offset) continue
      if (result.length >= filter.limit) { hasMore=true; break }
      result.push(record)
    }
    return { archive:archive.manifest, columns, rows:result, nextOffset:hasMore?filter.offset+result.length:null }
  } finally {
    rows.close()
    decoded.destroy()
    input.destroy()
  }
}
