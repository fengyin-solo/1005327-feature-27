import { downloadFile, filterRows } from '@/api/local-service'
import { CATEGORY_DEPARTMENTS } from '@/data/acceptance-routing'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 分送打包只认这四个栏目，缺任何一项都算缺项，挑出来不进包。
const REQUIRED_FIELDS = ['验收单号', '验收类别', '遗留问题数', '验收结论']

// 业务约定：单张验收单的遗留问题数在 0–99 之间，超出视为登记异常，不参与导出。
const ISSUE_COUNT_MAX = 99

// 打包台账：同一批（同类别、同验收单号集合）反复打包只登记一次，不重复计数。
const PACK_LEDGER_KEY = 'archaeology-field:acceptance-packs'

export type ExportFile = { filename: string; content: string; type?: string }

export type ExcludedRow = { row: EntryRow; reason: string }

export type PackSummary = {
  files: ExportFile[]
  excluded: ExcludedRow[]
  exportedCount: number
  freshPacks: number
  duplicatePacks: number
  unmatchedCategories: string[]
  messages: string[]
}

type PackLedger = Record<string, { category: string; count: number; firstPackedAt: string }>

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function issueCountInRange(raw: unknown): boolean {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return false
  }
  const value = Number(text)
  return value >= 0 && value <= ISSUE_COUNT_MAX
}

function loadLedger(): PackLedger {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  try {
    return JSON.parse(window.localStorage.getItem(PACK_LEDGER_KEY) ?? '{}') as PackLedger
  } catch {
    return {}
  }
}

function saveLedger(ledger: PackLedger): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PACK_LEDGER_KEY, JSON.stringify(ledger))
  }
}

// 同一类别里按验收单号去重，同一个单号只进一次包。
function dedupeByReceiptNo(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const receiptNo = String(row['验收单号']).trim()
    if (seen.has(receiptNo)) {
      return false
    }
    seen.add(receiptNo)
    return true
  })
}

export function buildAcceptancePacks(filters: Record<string, string> = {}): PackSummary {
  // 与验收单列表读同一份数据、过同一套筛选条件，保证导出条目和列表对得上。
  const rows = filterRows(listRows('acceptance'), filters)
  const today = formatDate(new Date())

  // 导出前先核一遍：缺项的、遗留问题数超出范围的，都不参与打包。
  const excluded: ExcludedRow[] = []
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const missing = REQUIRED_FIELDS.filter((field) => String(row[field] ?? '').trim() === '')
    if (missing.length > 0) {
      excluded.push({ row, reason: `缺项：${missing.join('、')}` })
      continue
    }
    if (!issueCountInRange(row['遗留问题数'])) {
      excluded.push({ row, reason: `遗留问题数超出范围（0–${ISSUE_COUNT_MAX}）：${String(row['遗留问题数'])}` })
      continue
    }
    const category = String(row['验收类别']).trim()
    const group = groups.get(category) ?? []
    group.push(row)
    groups.set(category, group)
  }

  const files: ExportFile[] = []
  const unmatchedCategories: string[] = []
  const ledger = loadLedger()
  let freshPacks = 0
  let duplicatePacks = 0
  let exportedCount = 0

  for (const [category, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh'))) {
    const packed = dedupeByReceiptNo(group)
    exportedCount += packed.length

    // 同一批复反复打包只算一次：台账里已有这一批就只出文件，不重复登记。
    const fingerprint = `${category}::${packed.map((row) => String(row['验收单号']).trim()).sort().join('+')}`
    if (ledger[fingerprint]) {
      duplicatePacks += 1
    } else {
      ledger[fingerprint] = { category, count: packed.length, firstPackedAt: today }
      freshPacks += 1
    }

    const department = CATEGORY_DEPARTMENTS[category]
    if (department) {
      // 验收结论以验收单登记时写入的为准：结论口径变更后不回溯重判历史验收单，导出原样照抄。
      const lines = [REQUIRED_FIELDS.join(',')]
      for (const row of packed) {
        lines.push(REQUIRED_FIELDS.map((field) => String(row[field] ?? '')).join(','))
      }
      files.push({
        filename: `探方验收单-${category}-${today}.csv`,
        content: `\uFEFF${lines.join('\n')}`,
      })
    } else {
      // 科室没匹配到的类别不出空文件，出一份说明，把暂存的验收单列清楚。
      unmatchedCategories.push(category)
      const lines = [
        '探方验收单分送说明',
        `验收类别：${category}`,
        `生成日期：${today}`,
        '',
        `「${category}」未在分送对照表中登记承接科室，本次不生成空包。`,
        '以下验收单暂存待分送，请先补登承接科室后重新打包：',
        ...packed.map(
          (row) => `${String(row['验收单号'])}（遗留问题数 ${String(row['遗留问题数'])}，验收结论：${String(row['验收结论'])}）`,
        ),
        `共 ${packed.length} 份。`,
      ]
      files.push({
        filename: `探方验收单-${category}-${today}-未匹配科室说明.txt`,
        content: lines.join('\n'),
        type: 'text/plain;charset=utf-8',
      })
    }
  }
  saveLedger(ledger)

  if (excluded.length > 0) {
    const lines = ['验收单号,验收类别,遗留问题数,验收结论,未导出原因']
    for (const { row, reason } of excluded) {
      lines.push(
        [...REQUIRED_FIELDS.map((field) => String(row[field] ?? '')), reason].join(','),
      )
    }
    files.push({
      filename: `探方验收-未参与导出记录-${today}.csv`,
      content: `\uFEFF${lines.join('\n')}`,
    })
  }

  const missingCount = excluded.filter(({ reason }) => reason.startsWith('缺项')).length
  const outOfRangeCount = excluded.length - missingCount
  const messages: string[] = []
  if (rows.length === 0) {
    messages.push('当前列表没有可导出的验收单')
  } else {
    messages.push(
      `已按验收类别打出 ${freshPacks + duplicatePacks} 个包（新登记 ${freshPacks} 个，重复 ${duplicatePacks} 个只算一次），送出 ${exportedCount} 份验收单`,
    )
    if (unmatchedCategories.length > 0) {
      messages.push(`类别「${unmatchedCategories.join('、')}」未匹配到科室，已附说明文件`)
    }
    if (excluded.length > 0) {
      messages.push(
        `${excluded.length} 条记录未参与导出（缺项 ${missingCount} 条、遗留问题数超范围 ${outOfRangeCount} 条），明细见未参与导出记录文件`,
      )
    }
  }
  return { files, excluded, exportedCount, freshPacks, duplicatePacks, unmatchedCategories, messages }
}

export function downloadAcceptancePacks(filters: Record<string, string> = {}): PackSummary {
  const summary = buildAcceptancePacks(filters)
  for (const file of summary.files) {
    downloadFile(file.filename, file.content, file.type)
  }
  return summary
}
