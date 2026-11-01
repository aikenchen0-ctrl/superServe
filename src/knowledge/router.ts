import {
  KnowledgeAccessError,
  type KnowledgeAccess,
  type KnowledgeDomain,
  type KnowledgeQuery,
  type KnowledgeResult,
  type KnowledgeStore,
} from './contracts.ts'
import { authorizeKnowledgeQuery } from './query.ts'

/** One device knowledge backend and the access range it is allowed to serve. */
export interface KnowledgeDevice {
  deviceId: string
  domains: readonly KnowledgeDomain[]
  store: KnowledgeStore
}

const emptyResult = (): KnowledgeResult => ({
  hits: [],
  truncated: false,
  omitted: { inaccessible: 0, deleted: 0, lowConfidence: 0 },
})

/** Routes a bounded query to authorized devices and merges their results without exceeding the caller limit. */
export class KnowledgeRouter implements KnowledgeStore {
  constructor(private readonly devices: readonly KnowledgeDevice[]) {}

  async query(query: KnowledgeQuery, access: KnowledgeAccess): Promise<KnowledgeResult> {
    const scope = authorizeKnowledgeQuery(query, access)
    const devices = this.devices.filter(device => scope.devices.has(device.deviceId))
    if (!devices.length) throw new KnowledgeAccessError('no registered knowledge device satisfies the request')
    const results = await Promise.all(devices.flatMap(device => [...new Set(device.domains)]
      .filter(domain => scope.domains.has(domain))
      .map(domain => device.store.query({ ...query, domains: [domain], devices: [device.deviceId] }, access))))
    const hits = results.flatMap(result => result.hits).filter(hit => scope.devices.has(hit.artifact.source.deviceId)
      && scope.domains.has(hit.artifact.domain))
      .sort((left, right) => right.score - left.score
        || right.artifact.observedAt.localeCompare(left.artifact.observedAt)
        || left.artifact.id.localeCompare(right.artifact.id))
    return {
      hits: hits.slice(0, scope.limit),
      truncated: results.some(result => result.truncated) || hits.length > scope.limit,
      omitted: results.reduce((total, result) => ({
        inaccessible: total.inaccessible + result.omitted.inaccessible,
        deleted: total.deleted + result.omitted.deleted,
        lowConfidence: total.lowConfidence + result.omitted.lowConfidence,
      }), emptyResult().omitted),
    }
  }
}
