// SQL 格式化（永辉风格：关键字小写、逗号前置、字段按原分组、别名/聚合字段单独一行）。
// 纯函数、无 React / DOM / store 依赖，供面板工具栏「格式化」按钮调用。
// 跳过字符串字面量/行注释/块注释，把 sql 里位置 → 是否「代码区」映射（字符串内关键字不误判）
function sqlMask(sql) {
  const mask = new Array(sql.length).fill(0) // 0=代码 1=字符串 2=注释
  let i = 0, n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === "'") {
      mask[i] = 1; i++
      while (i < n && sql[i] !== "'") { mask[i] = 1; i++ }
      if (i < n) { mask[i] = 1; i++ }
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') { mask[i] = 2; i++ }
    } else if (c === '/' && sql[i + 1] === '*') {
      mask[i] = 2; mask[i + 1] = 2; i += 2
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) { mask[i] = 2; i++ }
      if (i + 1 < n) { mask[i] = 2; mask[i + 1] = 2; i += 2 }
    } else { i++ }
  }
  return mask
}

// 括号感知：在代码区按 sep(默认逗号) 分割，返回 [{start,end,text}]（text 为原文，不含外围空白）
function splitCodeTop(sql, mask, sep) {
  const out = []
  let depth = 0, cur = -1, i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (mask[i] === 0) {
      if (c === '(') depth++
      else if (c === ')') { if (depth > 0) depth-- }
      else if (depth === 0 && c === sep) {
        if (cur !== -1) out.push({ start: cur, end: i })
        cur = -1
      } else if (cur === -1 && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') cur = i
    }
    i++
  }
  if (cur !== -1) out.push({ start: cur, end: sql.length })
  return out
}

// 找子句关键字出现位置（代码区，词边界，跳过括号内不算顶层——顶层扫描用）
function findTopKeywords(sql, mask) {
  // 返回按位置排序的 {kw, idx, end}
  const list = []
  const kws = ['select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'union all', 'union', 'inner join', 'left join', 'right join', 'full join', 'cross join', 'join', 'on', 'and', 'or', 'offset']
  // 词边界扫描
  let depth = 0
  for (let i = 0; i < sql.length; i++) {
    if (mask[i] !== 0) continue
    const c = sql[i]
    if (c === '(') depth++
    else if (c === ')') { if (depth > 0) depth--; continue }
    if (depth === 0 && /[A-Za-z]/.test(c)) {
      // 匹配关键字
      for (let k = 0; k < kws.length; k++) {
        const w = kws[k]
        const m = sql.slice(i, i + w.length).toLowerCase()
        if (m === w && !/[A-Za-z0-9_]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i + w.length] || '')) {
          list.push({ kw: w, idx: i, end: i + w.length })
          i = i + w.length - 1
          break
        }
      }
    }
  }
  return list
}

// 判断字段项是否有别名：末尾 "as x" 或 " x"（x 非保留字、非 ) 结尾的表达式边界情况）
function fieldAliasInfo(fieldText) {
  const t = String(fieldText || '').trim()
  const m = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(t)
  if (m) return { has: true, alias: m[1], isFunc: /\)\s*$/i.test(t.slice(0, t.length - m[0].length).trim()) || /[a-z_][a-z0-9_]*\s*$/i.test(t.slice(0, t.length - m[0].length).trim()) }
  // 无 as 的别名：x 结尾且前面不是操作符/函数（简判：末尾单词前有空白）
  const m2 = /\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(t)
  if (m2) {
    const pre = t.slice(0, t.length - m2[0].length).trim()
    const lastCh = pre.charAt(pre.length - 1)
    if (lastCh !== ',' && lastCh !== '(' && !/[+\-*/=<>]/.test(lastCh) && !/\b(from|where|join|on|group|order|having|and|or|case|when|then|else|end|in|between|like|is|not|as|union|limit)\s*$/i.test(pre)) {
      return { has: true, alias: m2[1], bare: true }
    }
  }
  return { has: false }
}

// 小写 SQL 保留字（仅代码区、词边界）
function lowerKeywordsIn(sql, mask) {
  const out = sql.split('')
  const kws = ['union all', 'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'inner join', 'left join', 'right join', 'full join', 'cross join', 'join', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'case', 'when', 'then', 'else', 'end', 'as', 'by', 'asc', 'desc', 'distinct', 'offset', 'over', 'partition by', 'rows', 'range', 'unbounded', 'preceding', 'following', 'current', 'if', 'then', 'exists', 'cast']
  for (let i = 0; i < sql.length; i++) {
    if (mask[i] !== 0) continue
    for (let k = 0; k < kws.length; k++) {
      const w = kws[k]
      const lw = w.toLowerCase()
      if (sql.slice(i, i + w.length).toLowerCase() === lw && !/[A-Za-z0-9_]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i + w.length] || '')) {
        for (let j = 0; j < w.length; j++) out[i + j] = lw[j]
        i += w.length - 1
        break
      }
    }
  }
  return out.join('')
}

// 格式化 SQL：处理 select 字段列表（分组/别名）、from/join/where 布局
function indentBlock(t) { return String(t || '').split('\n').map(function (l) { return l ? '    ' + l : l }).join('\n') }

function formatSql(sql) {
  if (!sql || !sql.trim()) return sql
  const mask = sqlMask(sql)
  const lower0 = lowerKeywordsIn(sql, mask)
  // 先提取文件头注释/说明行（-- 或 # 开头），再在 body 上检测 with/主查询
  const lines0 = lower0.split('\n')
  const head = []
  let body0 = lower0
  while (lines0.length && /^\s*(--|#)/.test(lines0[0])) { head.push(lines0.shift()); body0 = lines0.join('\n') }
  const headPre = head.length ? head.join('\n') + '\n' : ''
  // with CTE 前缀解析（括号配对提取 CTE，保留 with 结构、递归格式化内部）
  const bw = body0
  if (/^\s*with\b/i.test(bw)) {
    const collectCte = function (fromK) {
      let d = 0, j = fromK, str = false
      let asIdx = -1
      for (let q = j; q < bw.length; q++) {
        const c = bw[q]
        if (c === "'") { str = !str; continue }
        if (str) continue
        if (d === 0 && /\bas\b/i.test(bw.slice(q, q + 2)) && !/[A-Za-z0-9_]/.test(bw[q - 1] || '') && !/[A-Za-z0-9_]/.test(bw[q + 2] || '')) { asIdx = q; break }
        if (c === '(') d++
        else if (c === ')') { if (d > 0) d-- }
      }
      if (asIdx === -1) return null
      let pd = 0, p1 = -1, p2 = -1, ps = false
      for (let q = asIdx + 2; q < bw.length; q++) {
        const c = bw[q]
        if (c === "'") { ps = !ps; continue }
        if (ps) continue
        if (c === '(') { pd++; if (p1 === -1) p1 = q }
        else if (c === ')') { pd--; if (pd === 0) { p2 = q; break } }
      }
      if (p1 === -1 || p2 === -1) return null
      const nameSeg = bw.slice(fromK, asIdx).trim()
      const inner = bw.slice(p1 + 1, p2)
      return { nameSeg: nameSeg, inner: inner, tailStart: p2 + 1 }
    }
    const ctes = []
    let pos = bw.search(/\bwith\b/i) + 4
    let tailPart = null
    while (true) {
      while (pos < bw.length && /[\s,]/.test(bw[pos])) pos++
      const r = collectCte(pos)
      if (!r) { tailPart = bw.slice(pos); break }
      ctes.push({ nameSeg: r.nameSeg, inner: r.inner })
      let tp = r.tailStart
      while (tp < bw.length && /\s/.test(bw[tp])) tp++
      if (bw[tp] === ',') { pos = tp + 1; continue }
      tailPart = bw.slice(tp)
      break
    }
    if (ctes.length) {
      const blocks = ctes.map(function (c, i2) {
        return (i2 === 0 ? '' : ',\n') + c.nameSeg + ' as (\n' + indentBlock(formatSql(c.inner.trim())) + '\n)'
      })
      return (headPre + 'with\n' + blocks.join('') + '\n' + formatSql(tailPart ? tailPart.trim() : '')).trim()
    }
  }
  // 无 with：body 继续（head 已提出）
  const lower = body0
  let body = lower
  // 扫描 (select 开头的括号对，递归格式化括号内容（保持嵌套顺序：先替换内层由外层循环处理）
  const outChars = []
  let i = 0
  while (i < body.length) {
    if (body[i] === '(') {
      const rest = body.slice(i + 1)
      if (/^\s*select/i.test(rest)) {
        // 找配对 )
        let depth = 1, j = i + 1, inStr = false
        for (; j < body.length; j++) {
          const c = body[j]
          if (c === "'") { inStr = !inStr; continue }
          if (inStr) continue
          if (c === '(') depth++
          else if (c === ')') { depth--; if (depth === 0) break }
        }
        if (j < body.length) {
          const inner = body.slice(i + 1, j)
          outChars.push('(' + formatSql(inner) + ')')
          i = j + 1
          continue
        }
      }
    }
    outChars.push(body[i])
    i++
  }
  body = outChars.join('')
  const out = formatMain(body.trim())
  const tail = (head.length ? head.join('\n') + '\n' : '') + out
  return tail
}

// 主查询格式化（单条：select...from... 或 union 多条）
function formatMain(sql) {
  // 非 select 开头语句（insert/create/show/describe/use/set/drop/alter/grant 等）
  // 不重排字段（避免吃掉 create table ... as 之类前缀），只小写关键字 + 压缩多余空白
  if (!/^\s*select\b/i.test(sql)) {
    return sql.trim().replace(/[ \t]{2,}/g, ' ').replace(/ *([,;]) */g, '$1 ').replace(/ *\n */g, '\n')
  }
  // 处理 union 拆分
  const m0 = sql.match(/\bunion all\b|\bunion\b/i)
  if (m0 && !/union\s+select/i.test(sql.slice(0, m0.index))) {
    // union 分割
    const parts = sql.split(/\bunion all\b|\bunion\b/i).map(function (x) { return x.trim() })
    return parts.map(function (p, i) { return (i === 0 ? '' : '\nunion all\n') + formatMain(p) }).join('')
  }
  const mask = sqlMask(sql)
  const kws = findTopKeywords(sql, mask)
  // 定位 select 与 from
  const idxSel = kws.find(function (k) { return k.kw === 'select' })
  if (!idxSel) {
    // 非 select 语句（create/insert/show 等）→ 仅小写关键字 + 简单整理
    return sql.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
  }
  const idxFrom = kws.find(function (k) { return k.kw === 'from' && k.idx > idxSel.idx })
  const selEnd = idxFrom ? idxFrom.idx : (function () {
    // 无 from：到语句结束（可能含 where? 无 from 无 where）→ select 到末尾
    return sql.length
  })()
  // 记录 select 区在原输入中的行分布（分组依据）
  const selLines = sql.slice(idxSel.end, selEnd).split('\n').map(function (l) { return l.trim() })
  // 判断「原分组」：select 字段区是否多行
  const multi = selLines.filter(function (l) { return l.length }).length > 1
  const fields = splitCodeTopAbs(sql, mask, idxSel.end, selEnd, ',')
  if (!fields.length) return sql // 解析失败原样返回
  const grouped = [] // [{start,end,text,line}]
  fields.forEach(function (f) {
    const line = sql.slice(0, f.start).split('\n').length - 1
    grouped.push({ start: f.start, end: f.end, text: f.text, line: line })
  })
  // 输出 select 字段块
  const IND = '    '
  // 组装 select 行
  const fieldLinesOut = []
  // 按原分组（连续同行且同组）：multi && 非别名强制 → 组内保持同行
  let i = 0
  while (i < grouped.length) {
    const f = grouped[i]
    const al = fieldAliasInfo(f.text)
    // 别名/聚合? —— 别名强制单独一行；聚合(sum等)不强分（组内可能含 sum? 用户例子里 sum 单独一行——按原分组保留）
    const forceSingle = al.has
    // 分组：收集从 i 起 原行号相同 且 非 forceSingle 的连续字段
    if (multi && !forceSingle) {
      let j = i + 1
      while (j < grouped.length && grouped[j].line === f.line && !fieldAliasInfo(grouped[j].text).has) j++
      const group = grouped.slice(i, j)
      const oneLine = group.map(function (g) { return g.text.trim() }).join(', ')
      fieldLinesOut.push({ text: oneLine, first: group[0] })
      i = j
    } else {
      fieldLinesOut.push({ text: f.text.trim(), first: f })
      i++
    }
  }
  // 若原本单行(无分组) → 每个字段一行（上面的分支 multi=false 已每字段 push）
  // 生成字段行字符串（每行 4 空格缩进，逗号前置到后续行行首）
  let fieldBlock = ''
  for (let k = 0; k < fieldLinesOut.length; k++) {
    const fl = fieldLinesOut[k]
    fieldBlock += IND + (k === 0 ? '' : ',') + fl.text + '\n'
  }
  // 拼 select 头部
  let res = 'select\n' + fieldBlock.trimEnd()
  // from 及之后
  if (idxFrom) {
    // from 后布局 —— join/where/group by/order by/having/limit 前换行（若同行），
    // join 与 from 同级顶格；on 条件短时与 join 同行、长时换行缩进一级
    const rest = sql.slice(idxFrom.idx)
    const restMask = sqlMask(rest)
    // 找 rest 里顶层子句位置
    const marks = []
    let mm
    const re = /(\binner join\b|\bleft join\b|\bright join\b|\bfull join\b|\bcross join\b|\bjoin\b|\bwhere\b|\bgroup by\b|\border by\b|\bhaving\b|\blimit\b|\bunion all\b|\bunion\b)/gi
    while ((mm = re.exec(rest)) !== null) {
      if (restMask[mm.index] === 0) marks.push({ idx: mm.index, end: mm.index + mm[0].length, kw: mm[1].toLowerCase() })
    }
    // 只保留括号外（顶层）子句 —— 子查询内的 where/group by 等不拆行
    {
      const marks2 = []
      let d = 0
      for (let ri = 0; ri <= rest.length; ri++) {
        if (ri < rest.length) {
          const c = rest[ri]
          if (restMask[ri] === 0) {
            if (c === '(') d++
            else if (c === ')') { if (d > 0) d-- }
          }
        }
        while (marks.length && marks[0].idx <= ri) {
          if (d === 0) marks2.push(marks[0])
          marks.shift()
        }
      }
      while (marks.length) { marks2.push(marks.shift()) }
      marks.length = 0
      Array.prototype.push.apply(marks, marks2)
    }
    // 组装 from 块：from 行 + 各子句
    const lines = []
    let cursor = 0
    for (let mi = 0; mi < marks.length; mi++) {
      const mk = marks[mi]
      if (mk.idx > cursor) {
        const chunk = rest.slice(cursor, mk.idx).trim()
        if (chunk) lines.push(chunk)
      }
      // 找到子句内容结束（下一个 mark 或末尾）；内容从关键字后开始
      const nextIdx = mi + 1 < marks.length ? marks[mi + 1].idx : rest.length
      const content = rest.slice(mk.end, nextIdx).trim().replace(/[ \t]{2,}/g, ' ')
      // where 内 and/or 拆行；group by 字段逗号拆行（与 select 风格一致）
      if (mk.kw === 'where') {
        const conds = splitTopAndOr(content)
        if (conds.length > 1) {
          lines.push('where')
          conds.forEach(function (cd, ci) { lines.push(IND + (ci === 0 ? '' : cd[0] + ' ') + cd[1].trim()) })
        } else {
          lines.push('where ' + content)
        }
      } else if (mk.kw === 'group by' || mk.kw === 'order by') {
        const items = content.split(',').map(function (x) { return x.trim() }).filter(Boolean)
        if (items.length > 1 && mk.kw === 'group by') {
          lines.push(mk.kw)
          items.forEach(function (it, ii) { lines.push(IND + (ii === 0 ? '' : ',') + it) })
        } else {
          lines.push(mk.kw + (content ? ' ' + content : ''))
        }
      } else {
        lines.push(mk.kw + (content ? ' ' + content : ''))
      }
      cursor = nextIdx
    }
    if (cursor < rest.length) {
      const tailC = rest.slice(cursor).trim()
      if (tailC) lines.push(tailC)
    }
    res += '\n' + lines.join('\n')
  }
  // 无 from：select 字段区即全文（已在 res 重组），不再附加
  return res.replace(/[ \t]+\n/g, '\n')
}

// 绝对索引的括号感知分割（区间 [a,b) 内按逗号）
function splitCodeTopAbs(sql, mask, a, b, sep) {
  const out = []
  let depth = 0, cur = -1
  for (let i = a; i < b; i++) {
    const c = sql[i]
    const code = mask[i] === 0
    // 字符串/注释内容视为普通字段字符（不切分），仅代码区处理括号与分隔符
    if (code) {
      if (c === '(') depth++
      else if (c === ')') { if (depth > 0) depth-- }
      else if (depth === 0 && c === sep) {
        if (cur !== -1) out.push({ start: cur, end: i, text: sql.slice(cur, i) })
        cur = -1
      }
    }
    if (cur === -1 && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && !(code && (c === sep || c === '(' || c === ')'))) cur = i
  }
  if (cur !== -1) out.push({ start: cur, end: b, text: sql.slice(cur, b) })
  return out
}

// 括号感知按顶层 and/or 拆分（where 条件）：返回 [[op, text], ...]，首段 op=''，其余 op='and'/'or'
function splitTopAndOr(content) {
  const mask = sqlMask(content)
  const spots = []
  const re2 = /\b(and|or)\b/gi
  let m4
  while ((m4 = re2.exec(content)) !== null) {
    if (mask[m4.index] !== 0) continue
    let d2 = 0
    for (let q = 0; q < m4.index; q++) {
      const cq = content[q]
      if (mask[q] !== 0) continue
      if (cq === '(') d2++
      else if (cq === ')') { if (d2 > 0) d2-- }
    }
    if (d2 === 0 && !/[A-Za-z0-9_]/.test(content[m4.index - 1] || '')) {
      // between x and y 的 and 不拆（往前找最近 between/and/or 判断归属）
      if (m4[1].toLowerCase() === 'and') {
        let skip = false
        const backRe = /\b(between|and|or)\b/gi
        let bm, lastKw = null
        while ((bm = backRe.exec(content.slice(0, m4.index))) !== null) { lastKw = bm[1].toLowerCase() }
        if (lastKw === 'between') skip = true
        if (!skip) spots.push({ idx: m4.index, op: 'and' })
      } else {
        spots.push({ idx: m4.index, op: m4[1].toLowerCase() })
      }
    }
  }
  const res = []
  let prev = 0, prevOp = ''
  spots.forEach(function (sp) {
    const segTxt = content.slice(prev, sp.idx).trim()
    if (segTxt) res.push([prevOp, segTxt])
    prev = sp.idx + sp.op.length
    prevOp = sp.op
  })
  const lastTxt = content.slice(prev).trim()
  if (lastTxt) res.push([prevOp, lastTxt])
  return res
}

export { formatSql, formatMain, sqlMask, splitCodeTop, splitTopAndOr }
