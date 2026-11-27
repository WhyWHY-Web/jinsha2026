const dataRoot = new URL('../snapshot/', import.meta.url)
const transport = window.fetch.bind(window)
const cached = new Map()

export async function readFile(path) {
  const target = new URL(path, dataRoot)
  if (!target.href.startsWith(dataRoot.href)) throw new Error('Archive path unavailable')
  if (!cached.has(path)) {
    const response = transport(target).then(result => {
      if (!result.ok) throw Object.assign(new Error('Archive file unavailable'), {code:'ENOENT'})
      return result.text()
    })
    cached.set(path, response)
    response.catch(() => cached.delete(path))
  }
  return await cached.get(path)
}

export async function stat() {
  return { mtimeMs:0, size:0 }
}

export const join = (...segments) => segments.join('/')

export class WorkflowError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
