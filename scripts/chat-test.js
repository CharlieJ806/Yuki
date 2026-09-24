/**
 * SSE 解析 + 错误翻译的针对性测试。
 * 用一个本地 HTTP 服务模拟 OpenAI 兼容接口，覆盖：
 *   分块边界切断 JSON、多事件粘在一个 chunk、[DONE] 终止、注释行、
 *   401/429/404 错误翻译、abort 取消。
 *
 * 用法: node scripts/chat-test.js
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamChat, validateConfig, pingChat, ChatError, trimByChars, resolveChatConfig } from '../src/main/chat.js'
import {
  validateImageDataUrl,
  buildContent,
  textOfContent,
  imagesOfContent,
  normalizeForRequest,
  contentCost,
  modelSupportsImages,
  checkImagesForModel,
  withSelfPortrait,
} from '../src/shared/content.js'
import { createService } from '../src/main/service.js'
import { openStore } from '../src/main/store.js'

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.error(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

function checkIncludes(label, actual, needle) {
  checks++
  const ok = typeof actual === 'string' && actual.includes(needle)
  if (!ok) {
    failures++
    console.error(`✗ ${label}\n    expected to include: ${needle}\n    actual: ${actual}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

const settings = {
  chatBaseUrl: 'http://127.0.0.1:0/v1',
  chatApiKey: 'sk-test',
  chatModel: 'deepseek-chat',
  chatTemperature: 1.3,
  chatMaxHistory: 20,
  chatPersona: 'yuki',
}

/** 起一个可编程的假接口 */
function makeServer(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => handler(req, res, body))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function withServer(handler, fn) {
  const { server, port } = await makeServer(handler)
  try {
    return await fn(`http://127.0.0.1:${port}/v1`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const c of chunks) res.write(c)
  res.end()
}

const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

console.log('--- SSE 解析 ---')

/* 1. 普通流式 */
await withServer(
  (_req, res) => sse(res, [delta('摸鱼'), delta('快乐'), 'data: [DONE]\n\n']),
  async (baseUrl) => {
    let streamed = ''
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (_d, full) => (streamed = full),
    })
    check('普通流式拼接正确', r.content, '摸鱼快乐')
    check('onDelta 收到完整累计', streamed, '摸鱼快乐')
  },
)

/* 2. JSON 被 chunk 边界切断（最容易踩的坑） */
await withServer(
  (_req, res) => {
    const full = delta('半') + delta('句') + 'data: [DONE]\n\n'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    /* 每 7 个字节切一刀，强制跨 chunk */
    for (let i = 0; i < full.length; i += 7) res.write(full.slice(i, i + 7))
    res.end()
  },
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('跨 chunk 切断仍能解析', r.content, '半句')
  },
)

/* 3. 多个 data 事件粘在同一个 chunk */
await withServer(
  (_req, res) => sse(res, [delta('A') + delta('B') + delta('C') + 'data: [DONE]\n\n']),
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('粘包多事件全部解析', r.content, 'ABC')
  },
)

/* 4. 注释行与空行应被忽略 */
await withServer(
  (_req, res) => sse(res, [': keep-alive\n\n', '\n', delta('X'), 'data: [DONE]\n\n']),
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('忽略注释与空行', r.content, 'X')
  },
)

/* 5. 空回复应报错而不是静默返回空串 */
await withServer(
  (_req, res) => sse(res, ['data: [DONE]\n\n']),
  async (baseUrl) => {
    let err = null
    try {
      await streamChat({ settings: { ...settings, chatBaseUrl: baseUrl }, messages: [] })
    } catch (e) {
      err = e
    }
    checkIncludes('空回复抛错', err?.message, '空回复')
  },
)

/* 6. 模型名从响应里回读 */
await withServer(
  (_req, res) =>
    sse(res, [`data: ${JSON.stringify({ model: 'deepseek-reasoner', choices: [{ delta: { content: 'ok' } }] })}\n\n`, 'data: [DONE]\n\n']),
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('回读响应里的 model', r.model, 'deepseek-reasoner')
  },
)

console.log('\n--- 请求体 ---')

/* 7. 系统提示词与上下文条数是否正确送出去 */
await withServer(
  (req, res, body) => {
    const parsed = JSON.parse(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(delta(JSON.stringify({ model: parsed.model, msgs: parsed.messages.length })))
    res.write('data: [DONE]\n\n')
    res.end()
  },
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    })
    const echoed = JSON.parse(r.content)
    check('system 提示词已注入', echoed.msgs, 3)
  },
)

/* 8. Authorization 头是否存在 */
await withServer(
  (req, res) => {
    const auth = req.headers.authorization ?? ''
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(delta(auth ? 'has-auth' : 'no-auth'))
    res.write('data: [DONE]\n\n')
    res.end()
  },
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
    })
    check('带 Bearer 头', r.content, 'has-auth')
  },
)

/*
 * 9. 时间感：真正发出去的 system 里必须带「当前时间」。
 *
 * 这是用户实测的问题 —— 早上九点多她说要去吃午饭。
 * 单测里 resolveChatConfig 生成了时间块不算数，必须验证它真的上了网络，
 * 因为中间还夹着 trimByChars（按字符预算裁剪历史），
 * 万一预算算错把时间块挤掉，模型照样收不到。
 */
await withServer(
  (req, res, body) => {
    const parsed = JSON.parse(body)
    const sys = parsed.messages[0].content
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      delta(
        JSON.stringify({
          /* 时间块现在在末尾（前缀缓存），所以用 includes 而不是 startsWith */
          hasClock: sys.includes('【当前时间'),
          bansLunch: sys.includes('不要提吃午饭'),
          keepsPersona: sys.includes('你叫 Yuki'),
          /* 人设在前、时间块在后 —— 刻意如此，见 composeSystemPrompt */
          personaFirst: sys.indexOf('你叫 Yuki') < sys.indexOf('当前时间'),
          sysLen: sys.length,
        }),
      ),
    )
    res.write('data: [DONE]\n\n')
    res.end()
  },
  async (baseUrl) => {
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      /* 固定成 9:10，正是用户报问题的时间点 */
      runtime: { now: new Date(2026, 8, 21, 9, 10), workStart: '09:00', workEnd: '18:00', isRestDay: false },
      messages: [
        { role: 'user', content: '在干嘛' },
        { role: 'assistant', content: '在改作业' },
      ],
    })
    const got = JSON.parse(r.content)
    check('发出去的 system 带时间块', got.hasClock, true)
    check('9 点禁止提午饭', got.bansLunch, true)
    check('人设仍完整送达', got.keepsPersona, true)
    check('人设在时间块之前（缓存友好）', got.personaFirst, true)
    /* 时间块不能把 system 撑得离谱，否则会挤掉历史 */
    check('system 长度可控', got.sysLen < 2000, true)
  },
)

/* 10. 长历史裁剪时，时间块也不能被挤掉（它不在裁剪范围内的历史里） */
await withServer(
  (req, res, body) => {
    const parsed = JSON.parse(body)
    const sys = parsed.messages[0].content
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(delta(JSON.stringify({ hasClock: sys.includes('【当前时间'), total: parsed.messages.length })))
    res.write('data: [DONE]\n\n')
    res.end()
  },
  async (baseUrl) => {
    const history = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: '这是一条比较长的历史消息'.repeat(8),
    }))
    const r = await streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl, chatMaxChars: 3000 },
      runtime: { now: new Date(2026, 8, 21, 9, 10), workStart: '09:00', workEnd: '18:00' },
      messages: history,
    })
    const got = JSON.parse(r.content)
    check('长历史裁剪后时间块仍在', got.hasClock, true)
    check('历史确实被裁掉了', got.total < history.length + 1, true)
  },
)

/*
 * 11. 挂机台词：上下文里的角色必须如实送达。
 *
 * 这是用户反馈的实际 bug —— 她会对着自己说过的话发问。
 * 根因是把整段聊天记录拼成**一条 user 消息**，模型看到的是
 * 「用户转述的聊天记录」，认不出哪句是自己说的。
 * 这里起真实假接口，直接检查发出去的消息数组。
 */
{
  let sent = null
  await withServer(
    (req, res, body) => {
      sent = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '刚才说不困，现在有点困了' } }] }))
    },
    async (baseUrl) => {
      const svc = createService(openStore(join(mkdtempSync(join(tmpdir(), 'desk-chatter-')), 'c.db')))
      await svc.updateSettings({ chatBaseUrl: baseUrl, chatApiKey: '', chatPersona: 'yuki' })
      const sid = (await svc.ensureChatSession()).id
      await svc.addChatMessage(sid, 'user', '你还没睡吗')
      svc.addChatMessage(sid, 'assistant', '我今天好累，改了一下午图')
      svc.addChatMessage(sid, 'user', '那你早点休息')

      const out = await svc.generateChatterLine()
      check('挂机台词生成成功', out.ok, true)
      check('台词已清理', out.line, '刚才说不困，现在有点困了')
      svc.close()
    },
  )

  const roles = sent.messages.map((m) => m.role)
  check('首条是 system', roles[0], 'system')
  /* 关键：她自己的话必须以 assistant 送达，不能被包进 user 里 */
  check('含 assistant 轮次', roles.includes('assistant'), true)
  check('assistant 内容是她自己的话', sent.messages.find((m) => m.role === 'assistant').content, '我今天好累，改了一下午图')
  /* 绝不能出现「Yuki：」这种文字前缀 —— 那正是分不清的根源 */
  check('不带角色文字前缀', sent.messages.some((m) => m.content.includes('Yuki：')), false)
  check('末尾是触发指令', roles[roles.length - 1], 'user')
  check('system 说明了角色归属', sent.messages[0].content.includes('你自己说过的'), true)
}

/*
 * 12. 多模态：图片必须按官方格式送达，且不能出现在非法位置。
 *
 * DeepSeek 官方约束：图片只能放 user 消息，放 system/assistant 会 400。
 * 另外历史里的图片必须降级 —— 否则聊几轮就吃满上下文预算。
 */
console.log('\n--- 多模态图片 ---')

/* 1x1 透明 PNG，够用且不占体积 */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

check('合法 PNG 通过校验', validateImageDataUrl(TINY_PNG), null)
check('非 data URL 被拒', typeof validateImageDataUrl('https://x/y.png'), 'string')
check('不支持的格式被拒', typeof validateImageDataUrl('data:image/bmp;base64,AAAA'), 'string')
check('GIF 被接受', validateImageDataUrl('data:image/gif;base64,R0lGOD'), null)
check('WebP 被接受', validateImageDataUrl('data:image/webp;base64,UklGR'), null)

/* 内容块组装 */
check('无图时返回纯字符串', buildContent('你好', []), '你好')
check('只有图时不带空文本块', buildContent('', [TINY_PNG]).length, 1)
check('图文混排块顺序', buildContent('看这个', [TINY_PNG]).map((b) => b.type), ['text', 'image_url'])

/* 文本/图片提取（兼容两种 content 形态） */
check('字符串取文本', textOfContent('abc'), 'abc')
check('块数组取文本', textOfContent([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }]), 'a')
check('字符串无图', imagesOfContent('abc'), [])
check('块数组取图', imagesOfContent([{ type: 'image_url', image_url: { url: 'u' } }]), ['u'])

/* 规范化：图片只留最后一条 user，其余降级成文字占位 */
{
  const norm = normalizeForRequest([
    { role: 'user', content: buildContent('第一张', [TINY_PNG]) },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: buildContent('第二张', [TINY_PNG]) },
  ])
  check('历史图被降级为文字', String(norm[0].content).includes('[图片×1]'), true)
  check('最新图仍是块数组', Array.isArray(norm[2].content), true)
  check('assistant 消息不带块数组', Array.isArray(norm[1].content), false)
  /* 全请求只应有一张图在真正传输 */
  const total = norm.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image_url') : []))
  check('请求里只保留一张图', total.length, 1)
}

/* 含图消息的预算成本：不能按 base64 原始长度算，否则一张图就吃满预算 */
check('含图成本可控', contentCost(buildContent('hi', [TINY_PNG])) < 3000, true)
check('纯文本成本即长度', contentCost('abcd'), 4)

/* 端到端：真的发出去，并检查服务端看到的形态 */
{
  let got = null
  await withServer(
    (req, res, body) => {
      got = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('看到了'))
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async (baseUrl) => {
      const r = await streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl },
        runtime: { withClock: false },
        messages: [{ role: 'user', content: buildContent('这是什么', [TINY_PNG]) }],
      })
      check('带图请求成功', r.content, '看到了')
    },
  )
  const user = got.messages.find((m) => m.role === 'user')
  check('服务端收到块数组', Array.isArray(user.content), true)
  check('块顺序为 text,image_url', user.content.map((b) => b.type), ['text', 'image_url'])
  check('图片以 data URL 传递', user.content[1].image_url.url.startsWith('data:image/png'), true)
  /* 官方要求：图片不能出现在 system 消息 */
  check('system 消息不含图片块', Array.isArray(got.messages[0].content), false)
}

/*
 * 纯文本模型收到图片会 400。与其让用户对着含义模糊的上游报错发懵，
 * 不如在发送前就给出「换成哪个模型」的可执行提示。
 */
check('deepseek-chat 判为无视觉', modelSupportsImages('deepseek-chat'), false)
check('deepseek-reasoner 判为无视觉', modelSupportsImages('deepseek-reasoner'), false)
check('deepseek-flash 判为有视觉', modelSupportsImages('deepseek-flash'), true)
/* 自定义服务商多半支持视觉，不该被白名单误伤 */
check('未知模型默认放行', modelSupportsImages('qwen2.5-vl'), true)
check('空模型默认放行', modelSupportsImages(''), true)
check('无图时不拦', checkImagesForModel('deepseek-chat', []), null)
check('有图 + 纯文本模型要拦', typeof checkImagesForModel('deepseek-chat', [TINY_PNG]), 'string')
check('有图 + 视觉模型放行', checkImagesForModel('deepseek-flash', [TINY_PNG]), null)
/* 提示里必须写清怎么改，否则等于没说 */
check('提示里给出替代模型', checkImagesForModel('deepseek-chat', [TINY_PNG]).includes('deepseek-flash'), true)

/*
 * 让她「认识自己」：文字描述 + 参考图两条路都要生效。
 * 用户实测问题——把她的立绘发过去，她当成陌生人来描述。
 */
console.log('\n--- 认识自己 ---')

/* 人设里必须有外貌描述，否则她没有「自己长什么样」的概念 */
const yukiPrompt = resolveChatConfig({ ...settings, chatPersona: 'yuki' }, [], { withClock: false }).systemPrompt
check('人设含外貌段落', yukiPrompt.includes('【你的样子】'), true)
checkIncludes('含发色描述', yukiPrompt, '棕色长卷发')
checkIncludes('含瞳色描述', yukiPrompt, '红棕色')
checkIncludes('要求认出自己', yukiPrompt, '要能认出来那是你自己')
/* 也要防止硬认 —— 不像她就该说不像 */
checkIncludes('不像时要否认', yukiPrompt, '别硬认')

/* 参考图注入：位置、角色、不破坏原消息 */
{
  const BIG = `data:image/png;base64,${'A'.repeat(5000)}`
  const base = [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '最近一句' },
  ]
  const out = withSelfPortrait(base, BIG)
  check('注入后多两条', out.length, base.length + 2)
  /* 图片只能出现在 user 消息（官方硬约束） */
  check('参考图在 user 消息', out[0].role, 'user')
  check('参考图是块数组', Array.isArray(out[0].content), true)
  check('参考图真的带上了图', imagesOfContent(out[0].content).length, 1)
  /* 配一句 assistant 回执，让它像自然历史而不是孤立的指令 */
  check('配 assistant 回执', out[1].role, 'assistant')
  check('原消息顺序不变', out.slice(2).map((m) => m.content), ['第一句', '嗯', '最近一句'])
  check('不改原数组', base.length, 3)
  /* 没有参考图时不能凭空插消息 */
  check('无参考图则不注入', withSelfPortrait(base, '').length, base.length)
}

/* 端到端：参考图必须真的出现在发出去的请求里 */
{
  let got = null
  const BIG = `data:image/png;base64,${'B'.repeat(5000)}`
  await withServer(
    (req, res, body) => {
      got = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('这是我'))
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async (baseUrl) => {
      await streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl, chatModel: 'deepseek-flash' },
        runtime: { withClock: false },
        selfPortrait: BIG,
        messages: [{ role: 'user', content: '这是我吗' }],
      })
    },
  )
  const portraitMsg = got.messages.find((m) => Array.isArray(m.content) && imagesOfContent(m.content).length)
  check('参考图已送达', Boolean(portraitMsg), true)
  check('参考图在 user 消息', portraitMsg.role, 'user')
  /* system 里不能带图（官方 400） */
  check('system 不带图', Array.isArray(got.messages[0].content), false)
}

/*
 * 纯文本模型不能注入参考图 —— 会直接 400。
 * 这条保证「换了模型不至于连对话都用不了」。
 */
{
  let got = null
  const BIG = `data:image/png;base64,${'C'.repeat(5000)}`
  await withServer(
    (req, res, body) => {
      got = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('好'))
      res.write('data: [DONE]\n\n')
      res.end()
    },
    async (baseUrl) => {
      await streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl, chatModel: 'deepseek-chat' },
        runtime: { withClock: false },
        selfPortrait: BIG,
        messages: [{ role: 'user', content: '你好' }],
      })
    },
  )
  const anyImg = got.messages.some((m) => Array.isArray(m.content))
  check('纯文本模型不注入参考图', anyImg, false)
}

console.log('\n--- 错误翻译 ---')
for (const [status, expect] of [
  [401, 'API Key 无效'],
  [402, '余额不足'],
  [404, '接口地址不对'],
  [429, '太频繁'],
]) {
  await withServer(
    (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream says hi' } }))
    },
    async (baseUrl) => {
      let err = null
      try {
        await streamChat({ settings: { ...settings, chatBaseUrl: baseUrl }, messages: [] })
      } catch (e) {
        err = e
      }
      checkIncludes(`HTTP ${status} 翻译`, err?.message, expect)
      check(`HTTP ${status} status 透传`, err?.status, status)
    },
  )
}

/* 9. 连不上时的报错 */
{
  let err = null
  try {
    await streamChat({
      settings: { ...settings, chatBaseUrl: 'http://127.0.0.1:1/v1' },
      messages: [],
    })
  } catch (e) {
    err = e
  }
  checkIncludes('网络不通给出提示', err?.message, '连不上')
}

console.log('\n--- 配置校验 ---')

check('空 BaseURL', validateConfig({ ...settings, chatBaseUrl: '' }).ok, false)
check('非 http 地址', validateConfig({ ...settings, chatBaseUrl: 'ftp://x' }).ok, false)
check('远程缺 Key', validateConfig({ ...settings, chatBaseUrl: 'https://api.deepseek.com', chatApiKey: '' }).ok, false)
check('远程有 Key', validateConfig({ ...settings, chatBaseUrl: 'https://api.deepseek.com', chatApiKey: 'sk-x' }).ok, true)
check('本地免 Key', validateConfig({ ...settings, chatBaseUrl: 'http://localhost:11434/v1', chatApiKey: '' }).ok, true)

console.log('\n--- 取消 ---')

await withServer(
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(delta('开'))
    /* 挂住不结束，等客户端 abort */
    setTimeout(() => res.end(), 4000)
  },
  async (baseUrl) => {
    const controller = new AbortController()
    let caught = null
    const p = streamChat({
      settings: { ...settings, chatBaseUrl: baseUrl },
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    }).catch((e) => (caught = e))
    setTimeout(() => controller.abort(), 300)
    await p
    check('取消时抛 aborted', caught?.kind ?? caught?.name, 'aborted')
    check('取消时是 ChatError', caught instanceof ChatError, true)
  },
)

console.log('\n--- 上下文裁剪 ---')

check('空数组', trimByChars([], 100).length, 0)
check('单条超预算仍保留（不能裁空）', trimByChars([{ role: 'user', content: 'x'.repeat(9999) }], 100).length, 1)
check('预算充足全保留', trimByChars([{ role: 'user', content: 'aaa' }, { role: 'assistant', content: 'bbb' }], 100).length, 2)

/* 超预算时丢掉最早的，保留最近的，且顺序不变 */
{
  const msgs = [
    { role: 'user', content: 'A'.repeat(50) },
    { role: 'assistant', content: 'B'.repeat(50) },
    { role: 'user', content: 'C'.repeat(50) },
    { role: 'assistant', content: 'D'.repeat(50) },
  ]
  const out = trimByChars(msgs, 120)
  check('超预算裁掉最早两条', out.map((m) => m.content[0]), ['C', 'D'])
}

/* 边界：刚好等于预算应全保留 */
{
  const msgs = [
    { role: 'user', content: 'A'.repeat(50) },
    { role: 'assistant', content: 'B'.repeat(50) },
  ]
  check('刚好等于预算全保留', trimByChars(msgs, 100).length, 2)
}

/* 中文内容按字符数（每个汉字算 1） */
{
  const msgs = [
    { role: 'user', content: '摸'.repeat(30) },
    { role: 'assistant', content: '鱼'.repeat(30) },
  ]
  check('中文按字符计数', trimByChars(msgs, 40).map((m) => m.content[0]), ['鱼'])
}

/* 原数组不被修改 */
{
  const msgs = [{ role: 'user', content: 'A'.repeat(50) }, { role: 'assistant', content: 'B'.repeat(50) }]
  const before = JSON.stringify(msgs)
  trimByChars(msgs, 60)
  check('不修改入参数组', JSON.stringify(msgs), before)
}

/* reserveChars：system 提示词也要占预算，否则人设越长越容易超 */
{
  const msgs = [
    { role: 'user', content: 'A'.repeat(60) },
    { role: 'assistant', content: 'B'.repeat(60) },
  ]
  const out = trimByChars(msgs, 100, 60)
  check('预留 system 预算后只留最近一条', out.map((m) => m.content[0]), ['B'])

  /* 边界：单条就吃满预算时，只会多留「最近一条」——这是刻意的，
     否则模型收不到用户当前输入就没法回答 */
  const total = out.reduce((n, m) => n + m.content.length, 0) + 60
  check('超预算时最多只多留一条', out.length, 1)
  check('该情况下总量恰好=最近一条+预留', total, 120)
}

/* 预算充裕时，reserve 正常扣除 */
{
  const msgs = [
    { role: 'user', content: 'A'.repeat(50) },
    { role: 'assistant', content: 'B'.repeat(50) },
  ]
  const out = trimByChars(msgs, 300, 100)
  check('预算充裕时全保留', out.length, 2)
  check('充足情况下总量不超预算', out.reduce((n, m) => n + m.content.length, 0) + 100 <= 300, true)
}

check('预留超过预算时不裁空', trimByChars([{ role: 'user', content: 'hi' }], 50, 999).length, 1)
check('reserveChars 默认 0（兼容旧调用）', trimByChars([{ role: 'user', content: 'A'.repeat(40) }], 100).length, 1)

/* 端到端：预算要覆盖「人设 + 历史」的总量 */
{
  const cfg = resolveChatConfig({ ...settings, chatPersona: 'yuki', chatMaxChars: 3000 })
  const history = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: '这是一条比较长的历史消息'.repeat(3),
  }))
  const trimmed = trimByChars(history, cfg.maxChars, cfg.systemPrompt.length)
  const total = trimmed.reduce((n, m) => n + m.content.length, 0) + cfg.systemPrompt.length
  check('人设+历史总量不超预算', total <= cfg.maxChars, true)
  check('长历史被显著裁剪', trimmed.length < history.length, true)
}

console.log('\n--- 角色设定 ---')

{
  const yuki = resolveChatConfig({ ...settings, chatPersona: 'yuki' })
  checkIncludes('Yuki 人设被选中', yuki.systemPrompt, 'Yuki')
  check('人设 id 正确', yuki.personaId, 'yuki')
  check('人设提示词足够长', yuki.systemPrompt.length > 400, true)
  /* 关键约束：不黏人、不常生气、女大学生身份，缺一条人设就会跑偏 */
  checkIncludes('包含女大学生身份', yuki.systemPrompt, '女大学生')
  checkIncludes('包含不黏人约束', yuki.systemPrompt, '不黏人')
  checkIncludes('包含不常生气约束', yuki.systemPrompt, '不常生气')

  /* 用户定制的人设要点：专业、所在地、游戏喜好 —— 缺了会明显出戏 */
  checkIncludes('金融专业', yuki.systemPrompt, '金融')
  checkIncludes('深圳大学', yuki.systemPrompt, '深圳大学')
  checkIncludes('学长男友关系', yuki.systemPrompt, '地下男友')
  checkIncludes('游戏清单', yuki.systemPrompt, '瓦洛兰特')
  checkIncludes('donk 粉丝', yuki.systemPrompt, 'donk')
  checkIncludes('爱喝咖啡', yuki.systemPrompt, '爱喝咖啡')

  /* 已删除的人设 id 必须安全回退，不能让老用户的配置炸掉 */
  const removed = resolveChatConfig({ ...settings, chatPersona: 'girlfriend' })
  check('已删除人设安全回退', removed.personaId, 'yuki')

  /* 未知人设回退到第一个（Yuki）而不是报错 */
  const unknown = resolveChatConfig({ ...settings, chatPersona: 'nope' })
  check('未知人设回退到 Yuki', unknown.personaId, 'yuki')
  /* 已移除的旧人设 id 也要能安全回退 */
  const legacy = resolveChatConfig({ ...settings, chatPersona: 'moyu' })
  check('旧人设 id 安全回退', legacy.personaId, 'yuki')
}

console.log('\n--- 上下文上限配置 ---')

check('默认条数提升到 100', resolveChatConfig({ ...settings, chatMaxHistory: undefined }).maxHistory, 100)
check('默认字符预算 48000', resolveChatConfig({ ...settings, chatMaxChars: undefined }).maxChars, 48000)
check('条数上限被夹到 400', resolveChatConfig({ ...settings, chatMaxHistory: 9999 }).maxHistory, 400)
check('字符预算下限被夹到 2000', resolveChatConfig({ ...settings, chatMaxChars: 1 }).maxChars, 2000)

console.log('\n--- pingChat ---')

await withServer(
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: 'pong' } }] }))
  },
  async (baseUrl) => {
    const r = await pingChat({ settings: { ...settings, chatBaseUrl: baseUrl } })
    check('ping 成功', r.ok, true)
    check('ping 回读 model', r.model, 'deepseek-chat')
    check('ping 回读内容', r.reply, 'pong')
  },
)

await withServer(
  (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  },
  async (baseUrl) => {
    const r = await pingChat({ settings: { ...settings, chatBaseUrl: baseUrl } })
    check('ping 失败返回 ok:false', r.ok, false)
    checkIncludes('ping 失败带原因', r.reason, 'API Key')
  },
)

console.log('\n--- Tauri transport 包装（Rust http 代理的 JS 侧） ---')

/*
 * 用 Node fetch 模拟 http_proxy.rs 的帧协议（status 先行 / 按行推 line / end 收尾，
 * http_abort 映射到 AbortController），验证切面 = tauri-transport.js 的包装层：
 * 帧流 → ReadableStream 的转换、text/json 聚合、abort 本地竞速。
 * Rust 侧行切分的字节安全性由 cargo test 覆盖（lines_* 用例），两端各自盯一半。
 */
{
  const aborts = new Map()
  const mockInvoke = async (cmd, args = {}) => {
    if (cmd === 'http_abort') {
      const ctrl = aborts.get(args.id)
      if (ctrl) ctrl.abort()
      return aborts.has(args.id)
    }
    if (cmd !== 'http_fetch_stream') throw new Error(`mock 未实现命令: ${cmd}`)
    const { id, url, method, headers, body, onFrame } = args
    const ctrl = new AbortController()
    aborts.set(id, ctrl)
    try {
      const res = await fetch(url, { method, headers, body: body || undefined, signal: ctrl.signal })
      onFrame.onmessage({ event: 'status', status: res.status })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          onFrame.onmessage({ event: 'line', data: buf.slice(0, idx + 1) })
          buf = buf.slice(idx + 1)
        }
      }
      if (buf) onFrame.onmessage({ event: 'line', data: buf })
      onFrame.onmessage({ event: 'end', ok: true })
      return { ok: true, chunks: 0, bytes: 0 }
    } catch (e) {
      /* 与 Rust 一致：错误以 Err(String) 形态回传 */
      throw new Error(String(e?.message ?? e).slice(0, 200))
    } finally {
      aborts.delete(id)
    }
  }
  class MockChannel {}

  globalThis.window = globalThis.window ?? {}
  window.__TAURI__ = { core: { invoke: mockInvoke, Channel: MockChannel } }

  const { installTauriTransport } = await import('../src/renderer/src/lib/tauri-transport.js')
  const { setHttpTransport } = await import('../src/shared/bridge/transport.js')
  installTauriTransport()

  /* 流式：内容与默认 fetch 路径完全一致 */
  await withServer(
    (_req, res) => sse(res, [delta('经'), delta('代理'), 'data: [DONE]\n\n']),
    async (baseUrl) => {
      let streamed = ''
      const r = await streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl },
        messages: [{ role: 'user', content: 'hi' }],
        onDelta: (_d, full) => (streamed = full),
      })
      check('Tauri 流式拼接正确', r.content, '经代理')
      check('Tauri onDelta 累计一致', streamed, '经代理')
    },
  )

  /* 中文跨行完整性：Rust 按行推、这里转回字节，多字节字符不能坏 */
  await withServer(
    (_req, res) => sse(res, [delta('摸鱼中的「鱼」是三字节'), 'data: [DONE]\n\n']),
    async (baseUrl) => {
      const r = await streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl },
        messages: [{ role: 'user', content: 'hi' }],
      })
      check('Tauri 流式中文完整', r.content, '摸鱼中的「鱼」是三字节')
    },
  )

  /* 错误翻译走聚合 text()：!res.ok → safeText(res) → describeHttpError */
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limited' } }))
    },
    async (baseUrl) => {
      let err = null
      await streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl },
        messages: [],
      }).catch((e) => (err = e))
      check('Tauri 流式 429 翻译', [err instanceof ChatError, err?.status], [true, 429])
      checkIncludes('Tauri 429 提示太频繁', err?.message, '太频繁')
    },
  )

  /* 非流式（pingChat）走同一条流式命令 + json() 聚合 */
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: 'pong' } }] }))
    },
    async (baseUrl) => {
      const r = await pingChat({ settings: { ...settings, chatBaseUrl: baseUrl } })
      check('Tauri ping 成功', r.ok, true)
      check('Tauri ping 回读内容', r.reply, 'pong')
    },
  )

  /* 中断：signal.abort() 本地竞速抛 aborted，不等 Rust 回包 */
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('开'))
      setTimeout(() => res.end(), 4000)
    },
    async (baseUrl) => {
      const controller = new AbortController()
      let caught = null
      const p = streamChat({
        settings: { ...settings, chatBaseUrl: baseUrl },
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }).catch((e) => (caught = e))
      setTimeout(() => controller.abort(), 300)
      await p
      check('Tauri 取消时抛 aborted', caught?.kind ?? caught?.name, 'aborted')
      check('Tauri 取消时是 ChatError', caught instanceof ChatError, true)
    },
  )

  /* 还原默认 transport，防污染（本节之后无其他用例，属防御性收尾） */
  setHttpTransport(null)
}

console.log(`\n${checks - failures}/${checks} 通过`)
process.exit(failures > 0 ? 1 : 0)
