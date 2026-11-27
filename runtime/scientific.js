import { readFile } from './snapshot-io.js'
import { join } from './snapshot-io.js'




















export async function readScientificSummary(root        , basin                ) {
  const directory = join(root, 'scientific')
  try {
    const [manifestText, profileText] = await Promise.all([
      readFile(join(directory, 'manifest.json'), 'utf8'),
      readFile(join(directory, 'profiles.json'), 'utf8'),
    ])
    const archive = JSON.parse(manifestText)
    const all = JSON.parse(profileText)
    if (basin != null && !Object.hasOwn(all.subbasins, basin)) return null
    const profiles = basin == null ? all.watershed : all.subbasins[basin]
    const basins = Object.entries(all.subbasins).map(([id, profile]) => ({
      id, samples:profile[0].samples, coverage:profile[0].coverage,
    }))
    return {
      archive,
      scope:{kind:basin == null ? 'watershed' : 'subbasin', id:basin ?? null},
      profiles,
      basins,
    }
  } catch (error) {
    if ((error                         ).code === 'ENOENT') return null
    throw error
  }
}
