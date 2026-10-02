// 零依赖 ZIP 打包：纯前端环境没有后端归档服务，也不引入第三方依赖。
// 只用 STORE（不压缩）方式，足以容纳几个 CSV / 说明文本，浏览器端可直接生成 Blob 下载。

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) {
      // 注意优先级：位异或高于无符号右移，移位表达式必须加括号。
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    table[n] = value
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export type ZipEntry = {
  filename: string
  content: Uint8Array
}

// DOS 时间字段只精确到 2 秒，ZIP 规范如此，不影响解包取数。
function dosDateTime(date: Date): { time: number; day: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) << 0)
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function u16(value: number): Uint8Array {
  const buffer = new Uint8Array(2)
  new DataView(buffer.buffer).setUint16(0, value, true)
  return buffer
}

function u32(value: number): Uint8Array {
  const buffer = new Uint8Array(4)
  new DataView(buffer.buffer).setUint32(0, value >>> 0, true)
  return buffer
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}

// 文件名统一按 UTF-8 写入并置上 language-encoding 标志位（位 11），避免中文包名解压乱码。
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array {
  const { time, day } = dosDateTime(now)
  const encoder = new TextEncoder()

  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename)
    const checksum = crc32(entry.content)
    const size = entry.content.length

    // 本地文件头（签名 0x04034b50）
    const local = concat([
      u32(0x04034b50),
      u16(20), // 解压所需版本
      u16(0x0800), // 通用标志：bit 11 = UTF-8 文件名
      u16(0), // 压缩方式：STORE
      u16(time),
      u16(day),
      u32(checksum),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // 无扩展字段
      nameBytes,
      entry.content,
    ])
    localChunks.push(local)

    // 中央目录头（签名 0x02014b50）
    const central = concat([
      u32(0x02014b50),
      u16(20), // 制作版本
      u16(20), // 解压所需版本
      u16(0x0800),
      u16(0),
      u16(time),
      u16(day),
      u32(checksum),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // 扩展字段长度
      u16(0), // 文件注释长度
      u16(0), // 起始盘号
      u16(0), // 内部文件属性
      u32(0), // 外部文件属性
      u32(offset),
      nameBytes,
    ])
    centralChunks.push(central)

    offset += local.length
  }

  const localPart = concat(localChunks)
  const centralPart = concat(centralChunks)

  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralPart.length),
    u32(localPart.length),
    u16(0),
  ])

  return concat([localPart, centralPart, eocd])
}
