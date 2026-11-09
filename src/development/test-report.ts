import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'
import { AcceptanceResultSchema, type AcceptanceCheck } from './acceptance-checks.ts'

interface Node { name: string; attrs: Record<string, string>; children: Node[]; text: string }
export interface Counts { tests: number; passed: number; failures: number; errors: number; skipped: number }
const empty = (): Counts => ({ tests: 0, passed: 0, failures: 0, errors: 0, skipped: 0 })
/** 只携带固定类别，不把 XML 正文、测试名称或底层解析错误回显。 */
class ReportError extends Error { constructor(readonly code: string) { super(code) } }
const invalid = (code: string): never => { throw new ReportError(code) }
const add = (a: Counts, b: Counts) => { for (const key of Object.keys(a) as (keyof Counts)[]) a[key] += b[key] }
const sum = (node: Node, counts: Counts) => {
  for (const key of ['tests', 'failures', 'errors', 'skipped', 'disabled'] as const) {
    const value = node.attrs[key]
    if (value === undefined) continue
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
      || Number(value) !== (key === 'disabled' ? 0 : counts[key]))
      invalid('summary_mismatch')
  }
}
function xml(content: Buffer) {
  if (content.length > 4 * 1024 * 1024) return invalid('report_budget')
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content) }
  catch { return invalid('unsupported_encoding') }
  const parser = new SaxesParser({ xmlns: false })
  const stack: Node[] = []
  let root: Node | undefined, count = 0
  parser.on('doctype', () => invalid('doctype_forbidden'))
  parser.on('error', () => invalid('malformed_xml'))
  parser.on('xmldecl', declaration => {
    if (declaration.encoding && !/^(utf-?8|us-ascii)$/i.test(declaration.encoding)) invalid('unsupported_encoding')
  })
  parser.on('opentag', tag => {
    if (++count > 50_000 || stack.length >= 64 || Object.keys(tag.attributes).length > 64) invalid('report_budget')
    if (Object.keys(tag.attributes).some(key => (key === 'xmlns' || key.startsWith('xmlns:')) && tag.attributes[key] !== ''))
      invalid('unsupported_namespace')
    const node: Node = { name: tag.name, attrs: tag.attributes, children: [], text: '' }
    if (stack.length) stack.at(-1)!.children.push(node)
    else root = node
    stack.push(node)
  })
  const text = (value: string) => {
    const node = stack.at(-1)
    // 日志和断言正文不用于计数，也不保留到结果；仅收集 CTest 身份及测量值。
    const parent = stack.at(-2)
    if (node && (['Name', 'FullName'].includes(node.name)
      || (node.name === 'Test' && parent?.name === 'TestList')
      || (node.name === 'Value' && parent?.name === 'NamedMeasurement'
        && ['Exit Value', 'Exit Code', 'Completion Status'].includes(parent.attrs.name ?? '')))) {
      if (node.text.length + value.length > 8192) invalid('report_budget')
      node.text += value
    }
  }
  parser.on('text', text); parser.on('cdata', text)
  parser.on('closetag', () => { stack.pop() })
  parser.write(decoded).close()
  if (!root) return invalid('malformed_xml')
  return root
}
function junit(root: Node) {
  const identities = new Set<string>()
  const auxiliary = (node: Node) => {
    if (node.name === 'properties') {
      if (node.children.some(child => child.name !== 'property' || child.children.length)) invalid('unsupported_structure')
    } else if (node.children.length) invalid('unsupported_structure')
  }
  const walk = (node: Node, suites: string[]): Counts => {
    if (!['testsuite', 'testsuites'].includes(node.name)) return invalid('unsupported_structure')
    const result = empty(), path = [...suites, node.attrs.name ?? '']
    for (const child of node.children) {
      if (child.name === 'testsuite' || child.name === 'testsuites') add(result, walk(child, path))
      else if (child.name === 'testcase' && node.name === 'testsuite') {
        if (!child.attrs.name) return invalid('case_identity_missing')
        const key = JSON.stringify([path, child.attrs.classname ?? '', child.attrs.name])
        if (identities.has(key)) return invalid('duplicate_case')
        identities.add(key)
        if (child.attrs.status && !['run', 'passed', 'notrun'].includes(child.attrs.status))
          return invalid('unsupported_status')
        if (child.attrs.result && !['completed', 'skipped', 'suppressed'].includes(child.attrs.result))
          return invalid('unsupported_status')
        const outcomes = new Set(child.children.filter(value => ['failure', 'error', 'skipped'].includes(value.name)).map(value => value.name))
        if (child.children.some(value => !['failure', 'error', 'skipped', 'system-out', 'system-err', 'properties'].includes(value.name)))
          return invalid('unsupported_structure')
        for (const nested of child.children) auxiliary(nested)
        if (child.attrs.status === 'notrun' || ['skipped', 'suppressed'].includes(child.attrs.result ?? '')) outcomes.add('skipped')
        if (outcomes.size > 1) return invalid('conflicting_outcome')
        result.tests++
        const status = [...outcomes][0]
        result[status === 'failure' ? 'failures' : status === 'error' ? 'errors' : status === 'skipped' ? 'skipped' : 'passed']++
      } else if (!['properties', 'system-out', 'system-err'].includes(child.name)) return invalid('unsupported_structure')
      else auxiliary(child)
    }
    sum(node, result)
    return result
  }
  return walk(root, [])
}
function ctest(root: Node) {
  if (root.name !== 'Site') return invalid('unsupported_structure')
  if (root.children.some(node => node.name !== 'Testing')) return invalid('unsupported_structure')
  const testing = root.children.filter(node => node.name === 'Testing')
  if (testing.length !== 1) return invalid('unsupported_structure')
  const container = testing[0]!, lists = container.children.filter(node => node.name === 'TestList')
  const allowed = new Set(['TestList', 'Test', 'StartDateTime', 'StartTestTime', 'EndDateTime', 'EndTestTime', 'ElapsedMinutes'])
  if (container.children.some(node => !allowed.has(node.name))) return invalid('unsupported_structure')
  if (lists.length !== 1) return invalid('test_list_missing')
  const listed = lists[0]!.children.map(node => {
    if (node.name !== 'Test' || !node.text.trim()) return invalid('test_list_invalid')
    if (node.children.length) return invalid('test_list_invalid')
    return node.text.trim()
  })
  if (new Set(listed).size !== listed.length) return invalid('duplicate_case')
  const result = empty(), actual = new Set<string>()
  for (const node of container.children.filter(node => node.name === 'Test')) {
    const full = node.children.filter(child => child.name === 'FullName')
    if (full.length !== 1 || !full[0]!.text.trim() || full[0]!.children.length) return invalid('case_identity_missing')
    const id = full[0]!.text.trim()
    if (actual.has(id)) return invalid('duplicate_case')
    actual.add(id)
    if (node.children.some(child => !['Name', 'Path', 'FullName', 'FullCommandLine', 'Results', 'Labels'].includes(child.name)))
      return invalid('unsupported_structure')
    if (node.children.some(child => child.name === 'Labels'
      ? child.children.some(label => label.name !== 'Label' || label.children.length)
      : child.name !== 'Results' && child.children.length > 0)) return invalid('unsupported_structure')
    const status = node.attrs.Status
    if (!['passed', 'failed', 'notrun'].includes(status ?? '')) return invalid('unsupported_status')
    const results = node.children.filter(child => child.name === 'Results')
    if (results.length > 1) return invalid('unsupported_structure')
    if (status !== 'notrun' && results.length !== 1) return invalid('case_result_missing')
    const allMeasurements = results.flatMap(value => value.children)
    if (allMeasurements.some(value => !['Measurement', 'NamedMeasurement'].includes(value.name)
      || value.children.some(child => child.name !== 'Value' || child.children.length)))
      return invalid('unsupported_structure')
    const measurements = allMeasurements
      .filter(value => value.name === 'NamedMeasurement' && value.attrs.name === 'Exit Value')
    if (status === 'passed' && measurements.some(value => {
      const values = value.children.filter(child => child.name === 'Value')
      return values.length !== 1 || values[0]!.text.trim() !== '0'
    })) return invalid('conflicting_outcome')
    if (status === 'passed' && allMeasurements.some(value => value.name === 'NamedMeasurement'
      && value.attrs.name === 'Exit Code' && value.children.some(child => !['Completed', '0'].includes(child.text.trim()))))
      return invalid('conflicting_outcome')
    if (status === 'passed' && allMeasurements.some(value => value.name === 'NamedMeasurement'
      && value.attrs.name === 'Completion Status' && value.children.some(child => child.text.trim() !== 'Completed')))
      return invalid('conflicting_outcome')
    result.tests++
    result[status === 'passed' ? 'passed' : status === 'failed' ? 'failures' : 'skipped']++
  }
  if (actual.size !== listed.length || listed.some(id => !actual.has(id))) return invalid('test_list_mismatch')
  return result
}

/** 解析原始报告内容，不推断执行来源、产品根因或检查范围充分性。 */
export function parseTestReport(content: Buffer, expectation: AcceptanceCheck['result']) {
  const contract = AcceptanceResultSchema.parse(expectation)
  const digest = createHash('sha256').update(content).digest('hex')
  const assurance = { executionAuthenticated: false as const, coverageVerified: false as const, publishAllowed: false as const }
  try {
    const root = xml(content), counts = contract.format === 'junit-xml' ? junit(root) : ctest(root)
    const issues: string[] = []
    if (!counts.tests) issues.push('zero_tests')
    if (counts.tests < contract.minimumTests) issues.push('minimum_tests_unmet')
    if (counts.skipped) issues.push('tests_skipped')
    if (counts.failures || counts.errors) issues.push('failures_reported')
    return { parserVersion: 1 as const, sha256: digest, bytes: content.length, format: contract.format, counts, issues,
      state: issues.some(issue => issue !== 'failures_reported') ? 'incomplete' as const
        : issues.length ? 'failures_reported' as const : 'content_consistent' as const, assurance }
  } catch (error) {
    if (!(error instanceof ReportError)) throw error
    return { parserVersion: 1 as const, sha256: digest, bytes: content.length, format: contract.format,
      counts: null, issues: [error.code], state: 'invalid' as const, assurance }
  }
}
