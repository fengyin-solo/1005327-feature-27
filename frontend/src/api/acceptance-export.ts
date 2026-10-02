// 探方验收单分科室导出：按验收类别分组打包给对应科室，没有匹配到科室的类别单独出说明。
// 与列表页共用同一份验收单数据（filterRows + listRows），保证两处导出对得上、不重判结论。

import { filterRows } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { buildZip } from '@/utils/zip'

const MODULE_KEY = 'acceptance'

// 送审字段固定四列：科室收件只看单号、类别、遗留问题数、历史结论。
const EXPORT_FIELDS = ['验收单号', '验收类别', '遗留问题数', '验收结论'] as const

// 验收类别 → 收件科室：只维护能对上号的类别，其余归入未匹配。
export const DEPARTMENT_BY_CATEGORY: Record<string, string> = {
  阶段性验收: '考古部',
  完工验收: '项目管理科',
  关键遗迹验收: '文物保护科',
}

// 遗留问题数允许范围：非整数或越界的记录不参与导出，由页面单独挑出来核对。
const ISSUE_MIN = 0
const ISSUE_MAX = 99

// 反复打包同一批只算一次：按「类别 + 条目内容」指纹记台账，指纹不变就不再出新包。
const LEDGER_KEY = 'archaeology-field:acceptance-export-ledger'

type LedgerEntry = { fingerprint: string; packagedAt: string }
type Ledger = LedgerEntry[]

export type AcceptanceIssue = {
  row: EntryRow
  reason: '缺项' | '超出范围'
  detail: string
}

export type AcceptancePackage = {
  category: string
  department: string
  count: number
  filename: string
  blob: Blob
  fingerprint: string
  duplicated: boolean
}

export type AcceptanceNotice = {
  category: string
  count: number
  filename: string
  blob: Blob
}

export type AcceptanceExportResult = {
  scanned: number
  exported: number
  packages: AcceptancePackage[]
  newPackages: AcceptancePackage[]
  duplicatedPackages: AcceptancePackage[]
  notice: AcceptanceNotice | null
  missing: AcceptanceIssue[]
  outOfRange: AcceptanceIssue[]
}

export function todayText(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_')
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: EntryRow[]): Uint8Array {
  const lines = [EXPORT_FIELDS.join(',')]
  for (const row of rows) {
    lines.push(EXPORT_FIELDS.map((field) => csvCell(row[field] ?? '')).join(','))
  }
  // 带 BOM，Excel 直接打开中文不乱码。
  return new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}`)
}

// FNV-1a 32 位指纹：同一批条目（顺序无关）内容不变，指纹就不变。
function fingerprint(category: string, rows: EntryRow[]): string {
  const payload = rows
    .map((row) => EXPORT_FIELDS.map((field) => String(row[field] ?? '')).join('|'))
    .sort()
    .join('\n')
  let hash = 0x811c9dc5
  const text = `${category}#${payload}`
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function readLedger(): Ledger {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY)
    return raw ? (JSON.parse(raw) as Ledger) : []
  } catch {
    return []
  }
}

function writeLedger(ledger: Ledger): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
}

// 导出前逐条核对：先挑缺项，再验遗留问题数范围；验收结论沿用历史值，不按状态重判。
function inspectRow(row: EntryRow): AcceptanceIssue | null {
  const missingField = EXPORT_FIELDS.find((field) => String(row[field] ?? '').trim() === '')
  if (missingField) {
    return { row, reason: '缺项', detail: `缺少${missingField}` }
  }
  const issueText = String(row['遗留问题数']).trim()
  const issueCount = Number(issueText)
  if (!/^\d+$/.test(issueText) || issueCount < ISSUE_MIN || issueCount > ISSUE_MAX) {
    return {
      row,
      reason: '超出范围',
      detail: `遗留问题数「${issueText}」不在 ${ISSUE_MIN}–${ISSUE_MAX} 之间`,
    }
  }
  return null
}

export function prepareAcceptanceExport(
  filters: Record<string, string> = {},
  now: Date = new Date(),
): AcceptanceExportResult {
  // 与验收单列表同一数据同一筛选口径，列表里看到哪些，导出就核哪些。
  const scanned = filterRows(listRows(MODULE_KEY), filters)
  const missing: AcceptanceIssue[] = []
  const outOfRange: AcceptanceIssue[] = []
  const valid: EntryRow[] = []

  for (const row of scanned) {
    const issue = inspectRow(row)
    if (issue) {
      if (issue.reason === '缺项') {
        missing.push(issue)
      } else {
        outOfRange.push(issue)
      }
      continue
    }
    valid.push(row)
  }

  const matched = new Map<string, EntryRow[]>()
  const unmatched = new Map<string, EntryRow[]>()
  for (const row of valid) {
    const category = String(row['验收类别']).trim()
    const bucket = DEPARTMENT_BY_CATEGORY[category] ? matched : unmatched
    const group = bucket.get(category) ?? []
    group.push(row)
    bucket.set(category, group)
  }

  const dateText = todayText(now)
  const ledger = readLedger()
  const known = new Set(ledger.map((item) => item.fingerprint))

  const packages: AcceptancePackage[] = []
  for (const [category, rows] of matched) {
    const department = DEPARTMENT_BY_CATEGORY[category]
    const sign = fingerprint(category, rows)
    const duplicated = known.has(sign)
    const filename = `探方验收单_${safeName(department)}_${safeName(category)}_${dateText}.zip`
    const innerName = `探方验收单_${safeName(category)}_${dateText}.csv`
    const blob = new Blob([buildZip([{ filename: innerName, content: toCsv(rows) }], now) as BlobPart], {
      type: 'application/zip',
    })
    packages.push({ category, department, count: rows.length, filename, blob, fingerprint: sign, duplicated })
  }

  // 没匹配到科室的类别不发空包：一个类别都没匹配上时，notice 也为空。
  let notice: AcceptanceNotice | null = null
  if (unmatched.size > 0) {
    const lines: string[] = [
      '探方验收单未匹配科室说明',
      `生成日期：${dateText}`,
      '',
      '以下验收类别未在「验收类别-收件科室」对照表中登记，暂未分送，请补充对照关系后重新导出：',
      '',
    ]
    let total = 0
    for (const [category, rows] of [...unmatched].sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'))) {
      lines.push(`【验收类别】${category}（${rows.length} 单）`)
      for (const row of rows) {
        lines.push(
          `  - ${String(row['验收单号'])} | 遗留问题数 ${String(row['遗留问题数'])} | 验收结论：${String(row['验收结论'])}`,
        )
      }
      lines.push('')
      total += rows.length
    }
    const filename = `探方验收单_未匹配科室说明_${dateText}.txt`
    const blob = new Blob([new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}`) as BlobPart], {
      type: 'text/plain;charset=utf-8',
    })
    notice = { category: '', count: total, filename, blob }
  }

  const matchedCount = [...matched.values()].reduce((sum, rows) => sum + rows.length, 0)

  return {
    scanned: scanned.length,
    exported: matchedCount,
    packages,
    newPackages: packages.filter((item) => !item.duplicated),
    duplicatedPackages: packages.filter((item) => item.duplicated),
    notice,
    missing,
    outOfRange,
  }
}

// 触发下载后再记台账：新包一旦产出，同批再点就不会重复出包。
export function commitAcceptanceLedger(result: AcceptanceExportResult): void {
  if (result.newPackages.length === 0) {
    return
  }
  const ledger = readLedger()
  const stamp = new Date().toISOString()
  for (const item of result.newPackages) {
    ledger.push({ fingerprint: item.fingerprint, packagedAt: stamp })
  }
  writeLedger(ledger)
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 浏览器连续多文件下载容易被拦，顺序触发并留出间隔。
export async function downloadAcceptanceBundles(
  filters: Record<string, string> = {},
  now: Date = new Date(),
): Promise<AcceptanceExportResult> {
  const result = prepareAcceptanceExport(filters, now)
  const files: { blob: Blob; filename: string }[] = [
    ...result.newPackages.map((item) => ({ blob: item.blob, filename: item.filename })),
    ...(result.notice ? [{ blob: result.notice.blob, filename: result.notice.filename }] : []),
  ]
  for (const [index, file] of files.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    triggerDownload(file.blob, file.filename)
  }
  commitAcceptanceLedger(result)
  return result
}
