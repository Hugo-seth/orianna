import { isPublicationLocked, reconcileContentSnapshots } from './model.ts'
import type { ContentItem } from './model.ts'

/** Plan a non-destructive backup import without writing to storage. */
export function mergeContentImport(incoming: ContentItem[], current: ContentItem[]): ContentItem[] {
  const currentById = new Map(current.map(item => [item.id, item]))
  const proposedById = new Map(currentById)
  for (const item of incoming) {
    if (!isPublicationLocked(currentById.get(item.id))) proposedById.set(item.id, item)
  }

  // The confirmed backup wins ordinary draft collisions regardless of timestamp.
  // All collisions are resolved above, so reconciliation only clones the plan and
  // filters local tombstones; no trusted receipt merge may alter locked records.
  return reconcileContentSnapshots([...proposedById.values()], [])
}
