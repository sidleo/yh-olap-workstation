// 通用 UI 小工具：React 元素构造、数组/文本处理、剪贴板。
import { createElement } from 'react'

export const h = createElement

export function toArray(x) { return Array.isArray(x) ? x : [] }
export function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
export function fmtLog(s) { return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/gi, ' ') }

export function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) { return false }
}

export function modKeyOf(e) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
  return isMac ? e.metaKey : e.ctrlKey
}
