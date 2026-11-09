import { expect, it } from 'vitest'
import { parseTestReport } from '../src/development/test-report.ts'

const parse = (content: string, format: 'junit-xml' | 'ctest-xml' = 'junit-xml', minimumTests = 1) =>
  parseTestReport(Buffer.from(content), { format, path: 'Report.xml', minimumTests })
const test = (name: string, body = '', attributes = '') => `<testcase name="${name}" classname="Contract" ${attributes}>${body}</testcase>`
it('JUnit 使用实际条目，日志和 CDATA 不泄露也不虚增测试', () => {
  const result = parse(`<testsuite tests="2" failures="0" errors="0" skipped="0"><properties><property name="x" value="y"/></properties>
    ${test('a&amp;b')}${test('parameter[2]')}<system-out><![CDATA[PRIVATE_LOG <testcase/>]]></system-out></testsuite>`)
  expect(result).toMatchObject({ state: 'content_consistent', counts: { tests: 2, passed: 2, failures: 0, errors: 0, skipped: 0 },
    assurance: { executionAuthenticated: false, publishAllowed: false } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})
it('嵌套套件只统计叶测试一次；套件重排不改变计数', () => {
  const first = `<testsuite name="first" tests="1">${test('a')}</testsuite>`
  const second = `<testsuite name="second" tests="1">${test('a')}</testsuite>`
  const a = parse(`<testsuites tests="2">${first}${second}</testsuites>`)
  const b = parse(`<testsuites tests="2">${second}${first}</testsuites>`)
  expect(a.counts).toEqual(b.counts)
  expect(a.counts?.tests).toBe(2)
})
it.each(['<failure/>', '<error/>'])('非成功条目 %s 不被汇总遗漏', status => {
  const result = parse(`<testsuite>${test('fails', status)}</testsuite>`)
  expect(result.state).toBe('failures_reported')
  expect(result.issues).toContain('failures_reported')
})
it.each(['<skipped/>', '', 'status="notrun"', 'result="suppressed"'])('跳过或零测试 %s 不算完整', status => {
  const body = status === '' ? '' : status.startsWith('<') ? test('skip', status) : test('skip', '', status)
  expect(parse(`<testsuite>${body}</testsuite>`).state).toBe('incomplete')
})
it('最低数量只检验实际条目，不能以汇总数补足', () => {
  expect(parse(`<testsuite>${test('a')}</testsuite>`, 'junit-xml', 2).issues).toContain('minimum_tests_unmet')
  expect(parse(`<testsuite tests="2">${test('a')}</testsuite>`, 'junit-xml', 2)).toMatchObject({
    state: 'invalid', counts: null, issues: ['summary_mismatch'],
  })
})
it.each([
  `<testsuite failures="0">${test('a', '<failure/>')}</testsuite>`,
  `<testsuite>${test('a')}${test('a')}</testsuite>`,
  `<testsuite>${test('a', '<failure/><skipped/>')}</testsuite>`,
  '<testsuite><testcase/></testsuite>',
  `<testsuite><system-out>${test('hidden', '<failure/>')}</system-out></testsuite>`,
  '<testsuite><unknown status="failure"/></testsuite>',
  `<testsuite>${test('x', '', 'status="unknown"')}</testsuite>`,
  '<testsuite><testcase name="a"></testsuite>',
  '<testsuite/><testsuite/>',
  '<!DOCTYPE testsuite [<!ENTITY a "expansion">]><testsuite/>',
  '<!DOCTYPE testsuite SYSTEM "file:///private"><testsuite/>',
  '<testsuite xmlns="urn:other"/>',
  '<?xml version="1.0" encoding="UTF-16"?><testsuite/>',
])('无效或无法解释的报告不能视为完整：%s', content => {
  expect(parse(content).state).toBe('invalid')
})
it('读取体积和嵌套深度有界，编码损坏不得补字符后继续', () => {
  expect(parseTestReport(Buffer.from([0xff, 0xfe]), { format: 'junit-xml', path: 'a.xml', minimumTests: 1 }).state).toBe('invalid')
  expect(parse(' '.repeat(4 * 1024 * 1024 + 1)).issues).toContain('report_budget')
  expect(parse('<testsuites>'.repeat(65) + '</testsuites>'.repeat(65)).issues).toContain('report_budget')
})
const ctest = (status = 'passed', extra = '') => `<Site><Testing><TestList><Test>./contract</Test></TestList>
  <Test Status="${status}"><Name>contract</Name><Path>.</Path><FullName>./contract</FullName>
  <FullCommandLine>PRIVATE_COMMAND</FullCommandLine><Results><NamedMeasurement type="numeric/double" name="Execution Time"><Value>0.1</Value></NamedMeasurement>
  ${extra}<Measurement><Value>PRIVATE_OUTPUT</Value></Measurement></Results></Test><EndTestTime>123</EndTestTime></Testing></Site>`
it.each([['passed', 'content_consistent'], ['failed', 'failures_reported'], ['notrun', 'incomplete']] as const)(
  'CTest %s 基于逐测试状态并核对 TestList', (status, expected) => {
    const result = parse(ctest(status), 'ctest-xml')
    expect(result.state).toBe(expected)
    expect(result.counts?.tests).toBe(1)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })
it.each([
  ctest().replace('<Test>./contract</Test>', '<Test>./missing</Test>'),
  ctest().replace('<TestList>', '<TestList><Test>./contract</Test>'),
  ctest('timeout'),
  ctest('passed', '<NamedMeasurement name="Exit Value"><Value>1</Value></NamedMeasurement>'),
  ctest('passed', '<NamedMeasurement name="Exit Code"><Value>Timeout</Value></NamedMeasurement>'),
  ctest('passed', '<NamedMeasurement name="Completion Status"><Value>Timeout</Value></NamedMeasurement>'),
  ctest().replace('<Results>', '<Unknown><Test Status="failed"/></Unknown><Results>'),
  ctest().replace('<Path>.</Path>', '<Path><Test Status="failed"/></Path>'),
  ctest().replace('<Testing>', '<Unknown><Test Status="failed"/></Unknown><Testing>'),
])('CTest 不一致或未知状态拒绝：%s', content => {
  expect(parse(content, 'ctest-xml').state).toBe('invalid')
})
it('增加跳过、失败或缺少条目只能降低结论，不能因汇总外观变为通过', () => {
  const base = parse(`<testsuite>${test('a')}</testsuite>`)
  expect(base.state).toBe('content_consistent')
  expect(parse(`<testsuite>${test('a')}${test('b', '<skipped/>')}</testsuite>`).state).toBe('incomplete')
  expect(parse(`<testsuite>${test('a')}${test('b', '<failure/>')}</testsuite>`).state).toBe('failures_reported')
  expect(parse('<testsuite/>').state).toBe('incomplete')
})
