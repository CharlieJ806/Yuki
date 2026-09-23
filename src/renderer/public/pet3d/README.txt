3D 桌宠模型放这里，由 scripts/meshy-pet.js 生成。

为什么要这个目录：桌宠窗在「设置 → 桌宠外观 → 桌宠渲染」选了 3D 后，
会从这里加载 yuki.glb（文件名以 manifest.json 里的 main 为准）。

目录为空 = 3D 不可用，桌宠会自动用 2D 立绘，不会白屏。

生成：
  export MESHY_API_KEY=msy_xxx
  export HTTPS_PROXY=http://127.0.0.1:4780     # 本机出网需代理
  node scripts/meshy-pet.js

脚本会同时写 resources/pet3d/（源素材）和这里（渲染层加载的副本）。
两份不是冗余：打包后的 dist 是自包含的，asar 里没有 resources/。
