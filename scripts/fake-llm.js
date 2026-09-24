/**
 * 上下文验证用假接口 —— 把收到的 system 提示词长度与消息条数回吐出来，
 * 用于确认「长上下文」真的送达模型，而不是在客户端被悄悄裁掉。
 * 用法: node scripts/fake-llm.js 8788 --echo
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 8788)
const ECHO = process.argv.includes('--echo')

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* ignore */
    }

    const msgs = Array.isArray(parsed.messages) ? parsed.messages : []
    const systemMsg = msgs.find((m) => m.role === 'system')
    const convo = msgs.filter((m) => m.role !== 'system')
    const totalChars = msgs.reduce((n, m) => n + String(m.content ?? '').length, 0)

    if (parsed.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: 'pong' } }] }))
      return
    }

    const reply = ECHO
      ? `收到 ${convo.length} 条对话 / system ${systemMsg?.content?.length ?? 0} 字 / 总计 ${totalChars} 字`
      : '好的呀，我在呢~'

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const chars = [...reply]
    let i = 0
    let timer = null
    const stop = () => timer && clearInterval(timer)

    timer = setInterval(() => {
      if (i >= chars.length) {
        clearInterval(timer)
        timer = null
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify({ model: 'fake-model', choices: [{ delta: { content: chars[i] } }] })}\n\n`)
      i++
    }, 15)

    res.on('close', stop)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-llm listening on http://127.0.0.1:${PORT}/v1${ECHO ? ' (echo mode)' : ''}`)
})
