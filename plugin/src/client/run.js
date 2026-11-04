// 执行 / 停止 / 轮询 / 下载。
import { callHost } from './rpc.js'
import { toArray } from './util.js'
import { activeTab, sessionConfigsMap, showToast } from './store.js'
import { loadDownloads } from './resources.js'

const timer = {
  timeout(fn, ms) { const t = setTimeout(fn, ms); return function () { clearTimeout(t) } },
  interval(fn, ms) { const t = setInterval(fn, ms); return function () { clearInterval(t) } },
}

    function downloadBlob(method, args, onStatus) {
      callHost(method, args).then(function (r) {
        if (!r || !r.ok || !r.base64) {
          const msg = '下载失败: ' + (r && (r.error || r.httpError) ? (r.error || r.httpError) : '无文件内容')
          console.log('download failed', r)
          if (onStatus) onStatus(msg)
          return
        }
        try {
          const bin = atob(r.base64)
          const u = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
          const blob = new Blob([u], { type: 'application/octet-stream' })
          const fileName = (r && r.filename) || (args && args.fileName) || 'download.xlsx'
          if (URL && URL.createObjectURL) {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = fileName
            document.body.appendChild(a)
            a.click()
            timer.timeout(function () { URL.revokeObjectURL(url); a.remove() }, 2000)
          } else {
            const fr = new FileReader()
            fr.onload = function () {
              const a = document.createElement('a')
              a.href = fr.result
              a.download = fileName
              document.body.appendChild(a)
              a.click()
              timer.timeout(function () { a.remove() }, 2000)
            }
            fr.readAsDataURL(blob)
          }
          if (onStatus) onStatus('已开始下载 ' + fileName)
        } catch (e) {
          if (onStatus) onStatus('下载失败: ' + (e && e.message))
        }
      })
    }

    function doRun(st, sid, bump, onlyLines, sqlText) {
      const tab = activeTab(st)
      if (!tab) return
      let sql = tab.sql
      if (onlyLines && onlyLines.length === 2) {
        const lines = sql.split('\n')
        sql = lines.slice(onlyLines[0] - 1, onlyLines[1]).join('\n')
      } else if (sqlText && String(sqlText).trim()) {
        // 编辑器选区：由调用方（CM）传入选中文本
        sql = String(sqlText)
      }
      if (!sql.trim()) { tab.log = '无 SQL'; tab.finish = 'error'; bump(); return }
      const paramsArr = Object.keys(tab.params || {}).map(function (k) { return { key: k, value: tab.params[k] } })
      // Session 参数：只有勾选行进 executeConfigs（对象 {key:value}），无勾选则不传
      const payload = { sql: sql, engine: tab.engine, dsId: tab.dsId, params: paramsArr, executeConfigs: sessionConfigsMap(tab) }
      tab.running = true; tab.finish = 'run'; tab.log = ''; tab.errMsg = ''; tab.result = null; tab.executeId = ''
      tab.bottomTab = 'log'
      bump()
      callHost('olap.submit', { payload: payload }).then(function (r) {
        if (!r || !r.ok) {
          tab.running = false; tab.finish = 'error'; tab.errMsg = (r && r.error) || '提交失败'; tab.log = tab.errMsg
          bump(); return
        }
        const eid = r.data && r.data.executeId
        if (!eid) {
          // ===== WORKSTATION: 提交响应缺 executeId 也必须失败收尾（否则 running 永真 → 按钮卡「停止」）=====
          tab.running = false; tab.finish = 'error'; tab.errMsg = '提交响应缺少 executeId'; tab.log = tab.errMsg
          bump(); return
        }
        tab.executeId = eid
        pollRun(st, sid, bump, tab)
      })
    }

    // ===== WORKSTATION: 执行状态/结果轮询。=====
    // 本轮重构（2026-09-07，CDP 实测复现并修复「有结果但按钮卡停止」）：
    // ① runTab 绑定：原实现对每个循环/看门狗实时取 activeTab(st)，用户中途切到其他标签
    //    → alive()=false → 三个循环全部退出、看门狗也放弃 → 该运行永久卡在「停止」
    //    （实测：切走 45s+ 再切回，按钮永不复位，即使查询已出结果）。现在把运行绑定
    //    到发起时的 tab 对象，切标签不再影响轮询收尾。
    // ② 成功 = checkState finish==='ok'（后端完成信号，errMsg='请查看结果'）：原实现
    //    要求 result.list.length>0 才收尾，0 行结果永远走不到成功分支，只能等 40s 兜底
    //    （RPC 慢时远不止 40s）。0 行也是成功，收尾即切结果页。
    // ③ 看门狗改停滞检测：原实现在 45s 固定强杀，且日志关键词含「稍后」——实测日志
    //    「sql执行中,请稍后....」命中 → 仍在执行/慢但成功的查询被误标「执行超时或失败」。
    //    现在任一轮询 RPC 成功即续命，只有全部循环持续 >20s 无成功响应（RPC 全挂）
    //    才先做最终 checkState 再判定。长查询不再被误杀。
    // ④ 结果补拉：settle 成功但结果仍在物化（isReady='run'）→ fillResult 继续拉，
    //    就绪后补进结果页（原实现 resLoop 只拉 30s 就死，晚到的结果被吞成 0 行）。
    function pollRun(st, sid, bump, runTab) {
      const tab = runTab || activeTab(st)
      const rid = tab.executeId
      if (!rid) return
      const alive = function () {
        return tab && tab.running && tab.executeId === rid && st.tabs.indexOf(tab) !== -1
      }
      let gotResult = false
      let gotError = false
      let gotRealResult = false // 是否已拿到真实 result 响应（区别于 settle 的空默认值）
      let sawOkAt = 0           // checkState 首次 finish='ok' 的时刻
      let lastTick = Date.now() // 任一循环最近一次成功 RPC 的时刻（看门狗停滞判定）
      // 结果补拉：settle 成功后结果晚到（物化慢）时把 rows 补进结果页
      const fillResult = function (attempt) {
        if (tab.executeId !== rid) return
        callHost('olap.result', { requestId: rid, pageNo: 1, pageSize: 200 }).then(function (rr) {
          if (tab.executeId !== rid) return
          const rd = rr && rr.ok ? rr.data : null
          if (rd && rd.isReady === 'ok') {
            if (tab.result !== rd) { tab.result = rd; bump() }
            return
          }
          if (attempt < 120) timer.timeout(function () { fillResult(attempt + 1) }, 1000)
        }).catch(function () {
          if (attempt < 120) timer.timeout(function () { fillResult(attempt + 1) }, 1000)
        })
      }
      // 统一收尾：无论哪条路径判定失败/成功都走这里，保证 running 一定复位。
      const settle = function (asError, msg) {
        if (gotResult) return
        gotResult = true
        if (!alive()) return
        if (asError) {
          gotError = true
          tab.finish = 'error'
          tab.errMsg = msg || tab.errMsg || '执行失败'
          const sErrOne = String(tab.errMsg).replace(/\n+/g, ' ').trim()
          if (tab.log.indexOf('IMPALAERROR') === -1 && tab.log.indexOf(sErrOne) === -1) {
            tab.log = (tab.log || '') + (tab.log ? '\n' : '') + 'IMPALAERROR: [' + sErrOne + ']'
          }
          tab.bottomTab = 'log'
        } else {
          tab.finish = 'ok'
          tab.errMsg = ''
          tab.result = tab.result || { isReady: 'ok', list: [], columnNameList: [] }
          tab.bottomTab = 'result'
          if (!gotRealResult || !tab.result.isReady || tab.result.isReady !== 'ok') fillResult(0)
        }
        tab.running = false
        bump()
      }
      // 看门狗（停滞检测）：循环健康时不断续命；只有所有循环持续停滞（RPC 全挂）才
      // 做最终 checkState 并按结果收尾，杜绝按钮永久停在「停止」，也不误杀长查询。
      const watchdog = function () {
        if (!alive()) return
        if (Date.now() - lastTick <= 20000) { timer.timeout(watchdog, 30000); return }
        callHost('olap.state', { requestId: rid }).then(function (sr) {
          if (!alive()) return
          const sd = sr && sr.ok ? sr.data : null
          if (sd && sd.finish === 'ok') { settle(false); return }
          if (sd && sd.finish === 'error') { settle(true, String(sd.errMsg || '')); return }
          if (sd) { lastTick = Date.now(); timer.timeout(watchdog, 30000); return } // 还在执行 → 续命
          settle(true, '状态轮询中断，请重试')
        }).catch(function () {
          settle(true, '状态轮询中断，请重试')
        })
      }
      timer.timeout(watchdog, 45000)

      // 循环 1：getLogResult —— 累积日志；error 字段非空（非 '0'）即失败收尾
      const logLoop = function () {
        if (gotResult || !alive()) return
        callHost('olap.log', { requestId: rid }).then(function (lg) {
          if (gotResult || !alive()) return
          lastTick = Date.now()
          if (lg && lg.ok && lg.data) {
            const d = lg.data
            const txt = (d.data === undefined || d.data === null) ? '' : String(d.data)
            const errTxt = (d.error === undefined || d.error === null) ? '' : String(d.error)
            if (txt !== '' && txt !== '0') {
              if (tab.log && txt.indexOf(tab.log) === 0) tab.log = txt
              else if (tab.log && tab.log.indexOf(txt) !== -1) { /* 已包含，不重复追加 */ }
              else if (tab.log) tab.log = tab.log + '\n' + txt
              else tab.log = txt
            } else if (errTxt !== '' && errTxt !== '0') {
              // 后端把错误放 error 字段 → 追加一次并判定失败收尾（错误日志=执行已失败）
              if (!(tab.log || '').split('\n').some(function (l) { return l.indexOf(errTxt) !== -1 })) {
                tab.log = (tab.log || '') + (tab.log ? '\n' : '') + errTxt
              }
              settle(true, errTxt)
              return
            }
          }
          bump()
          timer.timeout(logLoop, 500)
        }).catch(function () {
          // RPC 异常：续排一次（不能静默死亡；收尾由 stateLoop/看门狗兜底）
          if (!gotResult && alive()) timer.timeout(logLoop, 500)
        })
      }

      // 循环 2：getSqlResult —— 拉到 isReady='ok' 或行数据即存入（成功/失败收尾归 stateLoop）
      const resLoop = function () {
        if (gotResult || !alive()) return
        callHost('olap.result', { requestId: rid, pageNo: 1, pageSize: 200 }).then(function (rr) {
          if (gotResult || !alive()) return
          lastTick = Date.now()
          const rd = rr && rr.ok ? rr.data : null
          if (rd && (rd.isReady === 'ok' || (rd.list && rd.list.length))) {
            gotRealResult = true
            tab.result = rd
            bump()
          }
          if (!gotResult && alive()) timer.timeout(resLoop, 500)
        }).catch(function () {
          if (!gotResult && alive()) timer.timeout(resLoop, 500)
        })
      }

      // 循环 3：checkState —— 完成/错误的权威信号；成功收尾带 ≤10s 结果物化宽限
      const stateLoop = function () {
        if (gotResult || !alive()) return
        callHost('olap.state', { requestId: rid }).then(function (sr) {
          if (gotResult || !alive()) return
          lastTick = Date.now()
          const sd = sr && sr.ok ? sr.data : null
          if (sd) {
            const sErr = String(sd.errMsg || '')
            const sFinish = sd.finish
            // 英文错误特征（任意 finish，含 finish=ok 但 errMsg 异常的反常返回）→ 失败
            if (/Error|Exception|Analysis|failed|Failed|Could not|SQLException|Invalid|unknown/i.test(sErr)) {
              settle(true, sErr)
              return
            }
            if (sFinish === 'error') {
              settle(true, sErr || '执行失败')
              return
            }
            if (sFinish === 'ok') {
              // 后端完成信号：0 行也是成功。结果已就绪立即收尾；仍在物化则最多等 10s，
              // 到点按成功收尾（结果由 fillResult 补拉，晚到也会补进结果页）。
              if (!sawOkAt) sawOkAt = Date.now()
              const rd = tab.result
              if (gotRealResult && rd && rd.isReady === 'ok') { settle(false); return }
              if (Date.now() - sawOkAt > 10000) { settle(false); return }
            }
          }
          timer.timeout(stateLoop, 500)
        }).catch(function () {
          if (!gotResult && alive()) timer.timeout(stateLoop, 500)
        })
      }

      logLoop()
      resLoop()
      stateLoop()
    }

    function killRun(st, sid, bump) {
      const tab = activeTab(st)
      if (tab && tab.executeId) {
        const rid = tab.executeId
        tab.running = false; tab.finish = 'cancel'; tab.log = (tab.log || '') + '\n已请求终止'
        tab.bottomTab = 'log'
        showToast(st, '正在终止任务…')
        bump()
        callHost('olap.kill', { requestId: rid, engine: tab.engine, dsId: tab.dsId }).then(function (r) {
          showToast(st, (r && r.ok) ? '任务已终止' : ('终止失败: ' + (r && r.error || '未知')))
        }).catch(function () { showToast(st, '终止请求发送失败') })
      }
    }

    function downloadSimple(st, sid, bump) {
      const tab = activeTab(st)
      if (!tab.executeId) {
        showToast(st, '请先执行 SQL 再发起全量下载')
        return
      }
      if (!(st.accounts || []).length) { showToast(st, '请先配置账号'); return }
      showToast(st, '正在创建下载工单…')
      callHost('olap.download.create', { kind: 'skip', requestId: tab.executeId, engine: tab.engine }).then(function (r) {
        if (r && r.ok) {
          tab.log = (tab.log || '') + '\n[下载] 已创建下载工单'
          st.downloadLoaded = false
          bump()
          loadDownloads(st, sid, bump)
          showToast(st, '下载工单已创建，可在下载中心查看')
        } else {
          tab.log = (tab.log || '') + '\n[下载] ' + ((r && r.error) || '创建失败')
          bump()
          showToast(st, '创建下载工单失败: ' + ((r && r.error) || '未知错误'))
        }
      }).catch(function () {
        showToast(st, '创建下载工单失败（网络错误）')
      })
    }

    // ===== WORKSTATION: SQL 格式化（永辉风格：关键字小写、逗号前置、字段按原分组、别名/聚合字段单独一行）=====
    // 跳过字符串字面量/行注释/块注释，把 sql 里位置 → 是否「代码区」映射（字符串内关键字不误判）

export { doRun, killRun, downloadSimple, downloadBlob }
