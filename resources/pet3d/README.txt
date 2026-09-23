3D 桌宠模型的源素材目录（scripts/meshy-pet.js 的产物落点）。

跑完后这里会有 yuki.glb 以及按动作拆分的 yuki-<action>.glb。
渲染层加载的是 src/renderer/public/pet3d/ 下的副本 ——
打包后的 dist 是自包含的，asar 里没有这一份。

这个目录可以安全清空：3D 不可用时桌宠会自动回落 2D 立绘。
