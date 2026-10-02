<template>
  <section class="page" data-module="acceptance">
    <header class="page-head">
      <div>
        <h2>探方验收管理</h2>
        <p class="page-desc">维护探方验收单，围绕验收单号、验收探方、验收类别、验收人做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记探方验收单</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          按验收类别分科室导出
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无探方验收数据，可先登记探方验收单</td>
        </tr>
      </tbody>
    </table>

    <section v-if="exportResult" class="export-panel">
      <h3>本次导出核对</h3>
      <p class="export-line">
        按当前列表口径共核对 {{ exportResult.scanned }} 单；新出包
        {{ exportResult.newPackages.length }} 个、分送
        {{ exportResult.exported }} 单；
        <span v-if="exportResult.duplicatedPackages.length">
          {{ exportResult.duplicatedPackages.length }} 个包与上次内容一致，未重复打包；
        </span>
        <span v-if="exportResult.notice">
          另有 {{ exportResult.notice.count }} 单未匹配到收件科室，已出说明文件（不出空包）；
        </span>
        <span v-if="exportResult.outOfRange.length + exportResult.missing.length === 0">
          遗留问题数全部在范围内，无缺项。
        </span>
      </p>
      <ul class="export-files">
        <li v-for="item in exportResult.packages" :key="item.filename">
          {{ item.duplicated ? '跳过重复打包：' : '已打包：' }}{{ item.filename }}
          （{{ item.department }} · {{ item.category }} · {{ item.count }} 单）
        </li>
        <li v-if="exportResult.notice" class="notice-file">{{ exportResult.notice.filename }}</li>
      </ul>
      <table
        v-if="exportResult.missing.length || exportResult.outOfRange.length"
        class="data-table issue-table"
      >
        <thead>
          <tr><th>验收单号</th><th>验收类别</th><th>遗留问题数</th><th>剔除原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in [...exportResult.missing, ...exportResult.outOfRange]" :key="Number(item.row.id)">
            <td>{{ item.row['验收单号'] || '—' }}</td>
            <td>{{ item.row['验收类别'] || '—' }}</td>
            <td>{{ item.row['遗留问题数'] === '' ? '—' : item.row['遗留问题数'] }}</td>
            <td>
              <span class="issue-tag" :class="item.reason === '缺项' ? 'tag-missing' : 'tag-range'">
                {{ item.reason }}
              </span>
              {{ item.detail }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条探方验收记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadAcceptanceBundles, type AcceptanceExportResult } from '@/api/acceptance-export'
import {
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('acceptance')
const columns = ["验收单号", "验收探方", "验收类别", "验收人", "验收日期", "遗留问题数", "验收结论", "验收状态"]
const actions = ["提交验收", "确认通过", "要求整改"]
const statuses = ["待验收", "验收中", "已通过", "已整改"]
const stats = [{"label": "待验收探方", "value": 0}, {"label": "已通过探方", "value": 0}, {"label": "遗留问题总数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const exporting = ref(false)
const exportResult = ref<AcceptanceExportResult | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows() {
  errorMessage.value = ''
  if (exporting.value) {
    return
  }
  exporting.value = true
  try {
    // 导出复用列表的筛选口径，两处看到的是同一份验收单数据。
    exportResult.value = await downloadAcceptanceBundles(filters.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '分科室导出失败'
  } finally {
    exporting.value = false
  }
}

function openCreate() {
  errorMessage.value = '探方验收单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '探方验收列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.export-panel {
  margin: 12px 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.export-panel h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.export-line {
  margin: 0 0 8px;
  font-size: 13px;
}
.export-files {
  margin: 0 0 8px;
  padding-left: 18px;
  font-size: 13px;
}
.notice-file {
  color: #b45309;
}
.issue-table {
  margin-top: 8px;
}
.issue-tag {
  display: inline-block;
  border-radius: 4px;
  padding: 0 6px;
  margin-right: 6px;
  font-size: 12px;
}
.tag-missing {
  background: #fef3c7;
  color: #92400e;
}
.tag-range {
  background: #fee2e2;
  color: #b42318;
}
</style>
