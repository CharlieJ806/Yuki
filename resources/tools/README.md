> **注**：本目录只保留说明文档。里面的脚本曾与本仓库 `scripts/` 下同名文件重复，
> 且是**旧版**（如 `split-sheet.js` 342 行 vs 新版 1057 行），已清理。
> 请用仓库根 `scripts/` 下的版本。

# 桌宠素材生成工具包

一次性整理：脚本 + 尝试过程中生成的所有图 + 踩坑记录。

---

## 目录

```
scripts/
  gen-sheet.js            调 API 生成 12 格拼图（带透明参数与参考图）
  remove-checkerboard.js  把「假棋盘格背景」转成真透明（有瑕疵，见下）
  split-sheet.js          把拼图切成 12 个独立 PNG
生成的图/
  1-第一版-无间隔-切不开.png    第一次尝试（失败案例）
  2-第二版-12格独立-可用.png    第二次尝试（排版成功）
  3-抠图后-有瑕疵.png          抠图尝试（脸被抠洞）
切图结果/
  12 个独立动作 PNG（从 3-抠图后 切出）
参考图/
  设定图1.png / 设定图2.png    角色设定图
```

---

## 快速使用

### 1. 生成拼图（调 API）

```bash
# 先干跑，不花钱，只打印会发送什么
PACKY_API_KEY=你的key node scripts/gen-sheet.js --group G1 --base https://cf.api.fan

# 确认无误后加 --yes 真实生成
PACKY_API_KEY=你的key HTTPS_PROXY=http://127.0.0.1:4780 \
  node scripts/gen-sheet.js --group G1 --base https://cf.api.fan --ref 设定图2.png --yes
```

可用分组：`G1` 状态与情绪 / `G2` 日常动作 / `G3` 服装① / `G4` 服装②

### 2. 切图

```bash
node scripts/split-sheet.js "生成的图.png" --grid 3x4 --out .tmp-split --trim \
  --names pose4,pose1,pose3,pose2,shy,angry,surprise,heart,shrug,thumbsup,stretch,clap
```

### 3. 抠图（当前有缺陷，见下）

```bash
node scripts/remove-checkerboard.js "输入.png" "输出-transparent.png"
```

---

## 三版图对比

| 文件 | 排版 | 背景 | 可用性 |
|---|---|---|---|
| **1-第一版** | ❌ 角色贴边、无间隔 | 假棋盘格 | ❌ 切不开 |
| **2-第二版** | ✅ 12 格独立、有间隔 | 假棋盘格 | ⚠️ 排版可用，需抠背景 |
| **3-抠图后** | ✅ | ⚠️ 真透明但**脸被抠出洞** | ❌ 边缘不可用 |

**结论：第二版排版是对的，问题只剩「背景」。**

---

## 踩坑记录（重要）

### A. 为什么第一版切不开

同样 1024×1536，第一版和第二版一张能切、一张不能。

**差别不在尺寸，在提示词的构图约束。** 第一版只说「划分 3×4 网格」，
模型按自己理解自由排布，角色贴边且互相侵占；第二版加了量化约束：

```
- 角色的总高度不能超过 N 像素（即格高的 90%）
- 角色的总宽度不能超过 N 像素（即格宽的 75%）
- 格子分界线处必须是完全透明的，不能有任何角色的头发、衣物、道具跨越
```

### B. 「假棋盘格」是怎么来的

**提示词里说「透明背景」没用。** 模型会用**画一个灰白方格图案**来响应你，
那些仍是不透明像素（colorType=2，无 alpha 通道）。

真透明只能靠请求里的 `background: "transparent"` 参数保证。
**Cherry Studio 的绘图界面不暴露这个参数**，所以用它出的图永远是假棋盘格。

### C. edits 端点为什么一直 500

实测数据（全部失败）：

| 测试 | 结果 |
|---|---|
| edits + 设定图1（原图 2MB） | HTTP 500 |
| edits + 设定图2（压缩 1.2MB） | HTTP 500 |
| edits + **210 字节极小图** | HTTP 500，**1.6 秒** |
| generations（纯文本、无参考图） | HTTP 500，**0.6 秒** |

**关键：连 210 字节的图和纯文本请求都失败，且 0.6~3 秒就返回。**

说明请求根本没到达生成阶段 —— `do request failed` 是转发层拿不到上游响应。
**这是中转上游故障，不是参数问题。**

> 顺带排除：不是图片大小、不是双参考图、不是尺寸、不是提示词长度。

**排查建议**：登录 cf.api.fan 后台看余额、公告、调用日志。

### D. Node fetch 调不通这个中转

这个中转是 **New API**（响应头带 `x-oneapi-request-id`）。它对 multipart
请求要求 `Expect: 100-continue`，而这个头在 Node 的 fetch/undici 里是
**被禁用的**（抛 `NotSupportedError: expect header not supported`）。

同样的字段、同样的边界格式：

```
curl  → HTTP 200（成功生成过）
fetch → HTTP 400「未指定模型名称，模型名称不能为空」
```

**所以 gen-sheet.js 内部改用系统自带的 curl。**

### E. 抠图当前的问题（未解决）

`remove-checkerboard.js` 用「亮度 ≥ 下界 且 饱和度 ≤ 上界」判背景候选，
再靠**连通性**决定是否删除。

**失败原因**：AI 画的**浅色皮肤**和**棋盘格亮块**的色值几乎相同
（实测都是 253,253,253）。所以脸部的浅色区域被误判成背景删掉了。

**已尝试的补救**（效果有限）：
- 用 10px 棋盘格周期性做二次筛选
- 限制「只删小面积连通块」

**根本困难**：白衬衫、浅色皮肤、棋盘格亮块三者颜色无法区分，
而脸部的浅色区域**从图像边缘走不通**（所以连通性也救不了）。

**可能的正确方向**（未实现）：利用棋盘格的**严格 10px 周期性 + 相位**，
检测「在 10px 网格上规律交替亮/暗」的区域，而不是按颜色判断。

---

## 参数速查

### gen-sheet.js

```
--group G1|G2|G3|G4   要生成哪一组
--base URL            中转地址
--ref 文件名          只用这一张参考图（不传则用全部设定图）
--size WxH            默认 1024x1536
--quality             默认 high
--model               默认 gpt-image-2.5-sunburst
--yes                 必须加才会真实调用 API（防止误触烧额度）
```

### split-sheet.js

```
--grid 3x4            分几列几行
--out 目录            输出位置
--trim                裁掉每格的透明边
--inset N             格线内缩 N 像素（消掉邻格的发梢/鞋尖）
--names a,b,c         输出文件名，按从左到右、从上到下的顺序
```

### remove-checkerboard.js

```
输入图 输出图         位置参数
```

---

## 关于 API 与透明（官方文档要点）

来自 OpenAI / APIYI 官方 FAQ 的实测数据：

| 提示词风格 | 真透明率 |
|---|---|
| 只描述主体 | 16/16 ✅ |
| 描述场景（森林、房间…） | 0/3 ❌ |
| 参考图有背景 + 不说移除 | 1/2 ⚠️ |
| 参考图有背景 + **明确说移除** | 8/8 ✅ |

**三条写作规则**：

1. ❌ 避免环境词：ground / sky / room / forest
2. ✅ 提示词结尾固定加：`isolated subject on a transparent background, no scenery, no ground, no shadow`
3. ✅ 参考图有背景时必须写：`remove the background entirely, keep only the character`

**其他要点**：
- `background: "transparent"` 必须配 `output_format: png` 或 `webp`（jpeg 无 alpha 会 400）
- edits 端点的透明是**重绘**，不是精确抠图；细节会变
- 不要传 `response_format`（400）和 `input_fidelity`（400）
- 请求超时要设 ≥360 秒，同步接口断开即丢失但**仍然计费**
- 参考图 ≤1.5MB/张，多图合计 <6MB

---

## 下一步方向

1. **等中转恢复**后重试 `gen-sheet.js`（参数都已验证正确）
2. **或改用 Cherry Studio 出图**（排版已验证可用）+ 修好抠图
3. 抠图的正确方向：改用**棋盘格周期性检测**，而不是颜色阈值
