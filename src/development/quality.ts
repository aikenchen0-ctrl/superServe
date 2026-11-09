import { createHash } from 'node:crypto'
import { z } from 'zod'
import { qualityFiles, QualityImportError } from './quality-files.ts'
import { QualityFormatSchema } from './quality-contracts.ts'

export { QualityImportError } from './quality-files.ts'
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().min(1).max(4096)
const sha = z.string().regex(/^[a-f0-9]{64}$/i)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const Request = z.object({
  directory: text, format: QualityFormatSchema,
  expectedCommit: oid.optional(), expectedScopeDigest: sha.optional(), expectedInputDigest: sha.optional(),
}).strict()
const Tests = z.object({ tests: count, failures: count, errors: count, skipped: count })
const Manifest = z.array(z.object({ path: text, sha256: sha })).min(1).max(20_000)
const Counts = z.record(z.string().min(1).max(80), count)
const Scope = z.object({ class: text, method: text, jvmMethod: text, descriptor: text, total: count, counts: Counts })
const ParseErrors = z.array(z.object({ file: text, error: text })).max(10_000)
const normalizedCounts = (values: Record<string, number>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0))
const normalizedScope = (values: z.infer<typeof Scope>[]) => values.map(value =>
  JSON.stringify({ ...value, counts: normalizedCounts(value.counts) })).sort()
const Jvm = z.object({
  schemaVersion: z.literal(1), status: z.enum(['running', 'failed', 'review_required']), fullWorkflowPassed: z.literal(false),
  baseline: z.object({ sdk: Tests, consumer: Tests, consumerBuild: z.literal('passed') }).nullable(),
  targetTests: Tests.nullable(),
  metrics: z.enum(['insufficient_evidence', 'review_required', 'metrics_only_pass']).nullable(),
  kotlinPlugin: z.object({ diagnosticOnly: z.boolean(), projectCompilerCompatibilityVerified: z.boolean() }).nullable(),
  mutation: z.object({
    executed: z.boolean(), status: z.enum(['tool_error', 'missing_report', 'plugin_not_verified', 'zero_mutants',
      'missing_target_mutants', 'review_required', 'report_requires_scope_review']),
    total: count.optional(), counts: Counts.optional(), scope: z.array(Scope).max(10_000).optional(),
  }).nullable(),
})
const Metrics = z.object({
  schemaVersion: z.literal(1), fullWorkflowPassed: z.literal(false),
  coverageMetric: text, threshold: z.number().finite().nonnegative(),
  status: z.enum(['insufficient_evidence', 'review_required', 'metrics_only_pass']),
  targets: z.array(z.object({ source: text, class: text, method: text, descriptor: text,
    status: z.enum(['not_computable', 'review_required', 'within_threshold']) })).min(1).max(10_000),
})
const Native = z.object({
  schemaVersion: z.literal(1).optional(), sourceCommit: oid, workingTreeDiffSha256: sha,
  firstPartyFiles: count, filters: z.array(text).min(1).max(10_000), jvmCoverageUsable: z.boolean(),
  gateThreshold: z.number().finite().nonnegative(),
  exitCodes: z.object({ ctestCoverage: z.number().int(), jvmNativeCoverage: z.number().int(),
    exploration: z.number().int(), gate: z.number().int(), strictParse: z.number().int() }),
  syntaxTreeErrors: ParseErrors,
})
const NativeReport = z.object({
  schema_version: z.literal(1), tool: z.literal('crap4cpp'), version: text,
  summary: z.object({ functions: count, missing_coverage: count, over_limit: count, limit: z.number().finite() }),
  functions: z.array(z.object({ file: text, name: text, start_line: count, end_line: count, complexity: count,
    coverage: z.number().min(0).max(100).nullable(), crap: z.number().finite().nonnegative().nullable() })).max(20_000),
})
const Commands = z.array(z.object({ name: z.string().min(1).max(80), exitCode: z.number().int().nullable() })).max(256)

type IssueKind = 'missing' | 'finding' | 'review' | 'stale'
interface Issue { code: string; kind: IssueKind; message: string; action: string; artifact?: string }

/** 解释固定格式的外来报告；读取不代表持久收录、执行可信或获得发布资格。 */
export async function inspectQualityEvidence(input: z.input<typeof Request>, signal?: AbortSignal, collected?: Map<string, Buffer>) {
  const parsed = Request.safeParse(input)
  if (!parsed.success) throw new QualityImportError('invalid_request', '证据目录、格式或预期身份参数无效')
  const request = parsed.data, files = await qualityFiles(request.directory, signal, collected)
  const issues: Issue[] = []
  const add = (code: string, kind: IssueKind, message: string, action: string, artifact?: string) =>
    issues.push({ code, kind, message, action, ...(artifact ? { artifact } : {}) })
  const json = async <T>(name: string, schema: z.ZodType<T>) => {
    const data = await files.json(name)
    if (data === undefined) return undefined
    const result = schema.safeParse(data)
    if (!result.success) {
      add('unsupported_report', 'missing', '报告格式或字段不受当前适配器支持',
        '核对报告生成脚本版本，保留原报告后补充对应适配', name)
      return undefined
    }
    return result.data
  }
  const manifest = async (name: string) => {
    const values = await json(name, Manifest)
    if (!values) return undefined
    const paths = new Set(values.map(value => value.path))
    if (paths.size !== values.length) {
      add('duplicate_input', 'missing', '输入清单存在重复路径', '由生成器去重并核对路径身份', name)
      return undefined
    }
    // 清单路径仅参加身份计算，不跟随读取源码、依赖或任何报告外路径。
    return identity(values.map(value => ({ path: value.path, sha256: value.sha256.toLowerCase() }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
  let reportedExecution: 'unknown' | 'running' | 'failed' | 'completed' = 'unknown'
  let sourceCommit: string | undefined, scopeDigest: string | undefined, inputDigest: string | undefined
  let mutationCounts: Record<string, number> | undefined
  const summary = await files.json('summary.json')
  if (request.format === 'jvm-trial-v1') {
    const result = Jvm.safeParse(summary)
    if (!result.success) {
      if (summary !== undefined) add('unsupported_summary', 'missing', 'JVM 汇总格式或版本不受支持',
        '提供完整 v1 试验汇总；符号自检通过不能替代试验报告', 'summary.json')
    } else {
      const report = result.data
      reportedExecution = report.status === 'review_required' ? 'completed' : report.status
      if (report.status !== 'review_required') add('trial_unfinished', 'missing', '试验未报告完整结束',
        '核对最后成功阶段和原始日志，不把失败直接归因于产品')
      for (const tests of [report.baseline?.sdk, report.baseline?.consumer, report.targetTests]) {
        if (!tests || !tests.tests || tests.skipped) {
          add('tests_incomplete', 'missing', '基线、消费者或目标测试存在缺项/跳过', '补齐原范围内的实际测试收据')
          break
        }
        if (tests.failures || tests.errors) {
          add('tests_failed', 'finding', '报告含测试失败或错误', '分诊产品、测试和环境原因，不能重跑到绿代替解释')
          break
        }
      }
      const metrics = await json('crap.json', Metrics)
      if (metrics) {
        if (metrics.status !== report.metrics) add('metrics_conflict', 'missing', '汇总与 CRAP 状态不一致', '核对是否混用了不同轮次')
        if (metrics.status === 'insufficient_evidence' || metrics.targets.some(target => target.status === 'not_computable'))
          add('mapping_incomplete', 'missing', '部分方法不可计算，不能补零', '补源码/字节码/覆盖映射或明确不支持范围')
        if (metrics.targets.some(target => target.status === 'review_required'))
          add('crap_review', 'review', '报告含待审查的复杂度风险', '结合契约和验证成本选题，不将阈值直接作为发布结论')
        scopeDigest = identity({ metric: metrics.coverageMetric, threshold: metrics.threshold,
          targets: metrics.targets.map(({ source, class: cls, method, descriptor }) =>
            JSON.stringify({ source, class: cls, method, descriptor })).sort() })
        if (new Set(metrics.targets.map(target => JSON.stringify([target.class, target.method, target.descriptor]))).size
          !== metrics.targets.length)
          add('duplicate_target', 'missing', '目标方法重复，无法确认统计分母', '核对目标配置及完整方法身份')
      }
      if (!report.kotlinPlugin || report.kotlinPlugin.diagnosticOnly || !report.kotlinPlugin.projectCompilerCompatibilityVerified)
        add('plugin_compatibility_unknown', 'missing', '目标编译器与 Kotlin 插件兼容性未证实', '补目标语义兼容证据，不能用加载成功替代')
      const mutation = report.mutation
      if (!mutation?.executed || !mutation.total) {
        add('mutation_missing', 'missing', '未得到有效变异执行结果', '区分零变异、工具错误、未覆盖和报告缺失后补证')
      } else {
        const supported = new Set(['KILLED', 'SURVIVED', 'NO_COVERAGE', 'TIMED_OUT', 'RUN_ERROR',
          'MEMORY_ERROR', 'NON_VIABLE', 'NOT_STARTED', 'STARTED'])
        mutationCounts = mutation.counts && Object.fromEntries(Object.entries(mutation.counts).filter(([key]) => supported.has(key)))
        if (!mutation.counts || Object.keys(mutation.counts).some(key => !supported.has(key))
          || Object.values(mutation.counts).reduce((sum, n) => sum + n, 0) !== mutation.total)
          add('mutation_counts_invalid', 'missing', '变异状态未知或计数不一致', '核对原始 mutations.xml 与适配器版本')
        if (mutationCounts?.SURVIVED) add('mutants_survived', 'review', '报告含存活变异，不自动认定为缺陷或等价',
          '按契约构造可解释反例；等价判断单独审查')
        if (mutationCounts && Object.entries(mutationCounts).some(([key, n]) => n > 0 && key !== 'KILLED' && key !== 'SURVIVED'))
          add('mutation_incomplete', 'missing', '未覆盖、超时或工具错误不能计为断言杀死', '补齐对应范围执行并保留原状态分母')
        const scope = await json('mutation-scope.json', z.array(Scope).max(10_000))
        if (!scope?.length || scope.some(item => !item.total
          || Object.values(item.counts).reduce((sum, n) => sum + n, 0) !== item.total
          || Object.keys(item.counts).some(key => !supported.has(key))
          || Object.entries(item.counts).some(([key, n]) => n > (mutation.counts?.[key] ?? 0))) || !mutation.scope
          || identity(normalizedScope(scope)) !== identity(normalizedScope(mutation.scope)))
          add('mutation_scope_incomplete', 'missing', '目标变异范围缺失或与汇总不一致', '逐项核对目标方法与原始范围，不缩小验收')
        if (!['review_required', 'report_requires_scope_review'].includes(mutation.status))
          add('mutation_status_incomplete', 'missing', '变异汇总仍声明工具、范围或报告缺项', '核对缺项原因，不能仅凭非零计数认定完成')
        if (scope && metrics) {
          const keys = (values: { class: string; method: string; descriptor: string }[]) =>
            values.map(value => JSON.stringify([value.class, value.method, value.descriptor])).sort()
          if (identity(keys(scope)) !== identity(keys(metrics.targets)))
            add('target_scope_mismatch', 'missing', 'CRAP 与变异目标范围不一致', '核对两份报告是否属于同一配置')
        }
      }
      const commands = await json('commands.json', Commands)
      if (commands) {
        for (const name of ['baseline', 'target-tests', 'kover-report', 'map-symbols', 'pit']) {
          const entries = commands.filter(command => command.name === name)
          if (entries.length !== 1 || entries[0]!.exitCode !== 0)
            add('command_unconfirmed', 'missing', '必需阶段未形成唯一成功回执', `核对 ${name} 阶段，禁止混入旧轮次`, 'commands.json')
        }
      }
      const before = await manifest('inputs-before.json'), after = await manifest('inputs-after.json')
      if (before && after && before !== after) add('inputs_changed', 'stale', '试验前后输入不同', '固定输入后重新采集受影响证据')
      if (before && before === after) inputDigest = before
      const classesBefore = await manifest('classes-before.json'), classesAfter = await manifest('classes-after.json')
      if (classesBefore && classesAfter && classesBefore !== classesAfter)
        add('classes_changed', 'stale', '试验前后字节码不同', '核对构建归属并重新验证')
      for (const name of ['tools.json', 'plugin-build.json']) await files.raw(name)
      for (const name of ['coverage.xml', 'symbols.xml', 'detekt.sarif', 'pit/mutations.xml']) await files.raw(name)
      const head = await files.text('head.txt')
      if (head !== undefined) {
        const commit = oid.safeParse(head.trim())
        if (commit.success) sourceCommit = commit.data
        else add('source_identity_invalid', 'missing', '历史源码提交声明无效', '补齐本轮实际源码身份', 'head.txt')
      }
    }
  } else {
    const result = Native.safeParse(summary)
    if (!result.success) {
      if (summary !== undefined) add('unsupported_summary', 'missing', '原生 CRAP 汇总格式不受支持',
        '提供固定配方的完整汇总，不能用安装记录替代', 'summary.json')
    } else {
      const report = result.data
      sourceCommit = report.sourceCommit
      scopeDigest = identity({ filters: [...report.filters].sort(), threshold: report.gateThreshold })
      inputDigest = await manifest('source-manifest.json')
      reportedExecution = [0, 2].includes(report.exitCodes.gate) ? 'completed' : 'failed'
      if (reportedExecution === 'failed')
        add('native_execution_failed', 'missing', '原生分析未形成完整结束声明', '核对执行日志，区分工具、环境与产品原因')
      if (report.exitCodes.ctestCoverage !== 0 || !report.firstPartyFiles)
        add('native_baseline_incomplete', 'missing', '主机基线或源码清单不完整', '核对实际测试与来源范围')
      if (!report.jvmCoverageUsable || report.exitCodes.jvmNativeCoverage !== 0)
        add('jni_coverage_missing', 'missing', '缺少可用 JVM/JNI 覆盖证据', '单独补证，不能用主机 CTest 替代 JNI')
      if (report.syntaxTreeErrors.length || ![0, 2].includes(report.exitCodes.strictParse))
        add('strict_parse_incomplete', 'missing', '严格解析有缺项，普通门禁成功不能遮盖', '补解析支持或独立证据，不放宽原范围')
      const parseErrors = await json('strict-parse-files.json', ParseErrors)
      if (parseErrors) {
        const ordered = (values: z.infer<typeof ParseErrors>) => values.map(value => JSON.stringify(value)).sort()
        if (identity(ordered(parseErrors)) !== identity(ordered(report.syntaxTreeErrors)))
          add('parse_errors_conflict', 'missing', '独立解析错误清单与汇总不一致', '核对原始语法失败，不忽略分项报告', 'strict-parse-files.json')
        if (parseErrors.length)
          add('parse_errors_reported', 'missing', '分项报告仍含语法解析失败', '补解析支持或独立证据，不缩小分析范围', 'strict-parse-files.json')
      }
      const gate = await json('gate.json', NativeReport)
      const strict = await json('strict-parse.json', NativeReport)
      for (const [name, data, exit] of [
        ['gate.json', gate, report.exitCodes.gate], ['strict-parse.json', strict, report.exitCodes.strictParse],
      ] as const) {
        if (!data) continue
        const values = data.functions, stats = data.summary
        if (!values.length || stats.functions !== values.length || stats.limit !== report.gateThreshold
          || stats.missing_coverage !== values.filter(value => value.coverage === null || value.crap === null).length
          || stats.over_limit !== values.filter(value => value.crap !== null && value.crap > stats.limit).length
          || exit !== (stats.over_limit > 0 ? 2 : 0))
          add('native_report_conflict', 'missing', '原生报告计数、阈值或退出码不一致', '核对原始运行和报告，不能只看汇总', name)
        if (values.some(value => value.coverage === null || value.crap === null))
          add('coverage_missing', 'missing', '方法缺失真实覆盖或分数', '补覆盖映射，缺项不得按零分计入', name)
      }
      if (report.exitCodes.gate === 2 || gate?.summary.over_limit)
        add('crap_threshold_exceeded', 'review', '部分方法超过当前配方阈值', '结合行为契约审查，不按分数直接重构')
      const normalizedNative = (value: z.infer<typeof NativeReport>) =>
        ({ ...value, functions: value.functions.map(item => JSON.stringify(item)).sort() })
      if (gate && strict && identity(normalizedNative(gate)) !== identity(normalizedNative(strict)))
        add('strict_gate_mismatch', 'missing', '普通与严格报告的范围或结果不一致', '核对被跳过语法和完整目标范围')
      await files.raw('native-cobertura.xml')
      if (report.jvmCoverageUsable)
        for (const name of ['jvm-native-cobertura.xml', 'combined-cobertura.xml']) await files.raw(name)
    }
  }
  for (const file of files.references) {
    if (file.status !== 'read' || !file.bytes)
      add('artifact_unavailable', 'missing', '必需文件缺失、损坏、为空或超过读取预算',
        '保留原文件并补齐受支持的完整报告，不据此判定产品失败', file.name)
  }
  for (const [expected, actual, label] of [
    [request.expectedCommit, sourceCommit, '源码提交'],
    [request.expectedScopeDigest?.toLowerCase(), scopeDigest, '检查范围'],
    [request.expectedInputDigest?.toLowerCase(), inputDigest, '输入清单'],
  ]) {
    if (expected && expected !== actual) add(actual ? 'expected_identity_mismatch' : 'expected_identity_missing',
      actual ? 'stale' : 'missing', `${label}与调用方预期不匹配或无法确认`, '核对目标绑定，不能沿用旧证据')
  }
  await files.finish()
  add('external_evidence_unverified', 'review', '这是外来证据的只读解释，执行来源与完整验收输入未验证',
    '核验来源、原始报告语义、权限及验收范围后再接入受管证据')
  const evidence = issues.some(issue => issue.kind === 'stale') ? 'stale'
    : issues.some(issue => issue.kind === 'missing') ? 'insufficient_evidence'
    : issues.some(issue => issue.kind === 'finding') ? 'findings_reported' : 'review_required'
  return {
    schemaVersion: 1 as const, adapter: request.format,
    bundleDigest: identity({ adapter: request.format, files: files.references }),
    reportedExecution, evidence, issues,
    declaredIdentity: { sourceCommit, scopeDigest, inputDigest }, mutationCounts,
    artifacts: files.references,
    assurance: { readOnly: true, persisted: false, rawArtifactsParsed: false, inputClosureVerified: false,
      sourceAuthenticated: false, snapshotCaptured: false, candidateEligible: false, publishAllowed: false },
  }
}
