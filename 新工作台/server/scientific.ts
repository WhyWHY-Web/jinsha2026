import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SoilDistribution = {
  mean: number; min: number; max: number; p10: number; median: number; p90: number
}

export type SoilProfile = {
  depth: string; inside: number; samples: number; coverage: number
  properties: Record<string, SoilDistribution | null>
}

type SoilArchive = {
  id: string; label: string; source: string; kind: string; rows: number; file: string
  description: string; sourceUrl: string; licenseUrl: string; attribution: string
  nativeResolutionMetres: number; outputSpacingDegrees: [number, number]; outputCrs: string
  fields: Array<{field: string; label: string; unit: string}>
  processing: string
}

type Profiles = { watershed: SoilProfile[]; subbasins: Record<string, SoilProfile[]> }

export async function readScientificSummary(root: string, basin?: string | null) {
  const directory = join(root, 'scientific')
  try {
    const [manifestText, profileText] = await Promise.all([
      readFile(join(directory, 'manifest.json'), 'utf8'),
      readFile(join(directory, 'profiles.json'), 'utf8'),
    ])
    const archive = JSON.parse(manifestText) as SoilArchive
    const all = JSON.parse(profileText) as Profiles
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
