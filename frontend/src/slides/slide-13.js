window.slideDataMap.set(13, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ P5 · 入口与校验 ]</div>
        <h1 class="text-4xl font-bold text-white">能力卡片与前置校验</h1>
      </div>
      <div class="grid grid-cols-3 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7 flex flex-col">
          <div class="flex items-center gap-3 mb-4"><div class="w-10 h-10 rounded bg-cyan-500/20 border border-cyan-400 flex items-center justify-center text-cyan-300 font-mono">07</div><h3 class="text-xl font-bold text-cyan-300">第 7 张卡</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">在 <span class="font-mono text-cyan-300">ReportPage</span> 的 reportCards 数组新增"项目启动会 PPT 生成"卡，<span class="text-cyan-300">复用 ReportCard 组件</span>，不新造卡片/样式。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7 flex flex-col">
          <div class="flex items-center gap-3 mb-4"><div class="w-10 h-10 rounded bg-purple-500/20 border border-purple-400 flex items-center justify-center text-purple-300 font-mono">Pre</div><h3 class="text-xl font-bold text-purple-300">前置校验</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed"><span class="text-purple-300">Preflight</span> 聚合查询资料齐备性，缺料时<span class="text-purple-300">硬阻塞</span>并提示，避免半截生成。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7 flex flex-col">
          <div class="flex items-center gap-3 mb-4"><div class="w-10 h-10 rounded bg-amber-500/20 border border-amber-400 flex items-center justify-center text-amber-300 font-mono">UI</div><h3 class="text-xl font-bold text-amber-300">面板互斥</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">与既有 6 张卡一致的<span class="text-amber-300">光晕 / hint 风格</span>与面板开关，保持 AI 控制台整体一致性。</p>
        </div>
      </div>
      <div class="mt-6 flex items-center gap-4 px-6 py-4 bg-slate-900/70 border-l-4 border-cyan-400 rounded">
        <span class="text-cyan-300 font-mono text-sm">现状</span>
        <span class="text-slate-300 text-[15px]">AI 控制台已有 6 张卡（计划导入 / 离线周报 / AI 周报 / 需求生成 PRD / 导入计划 / 生成用例）；新卡为第 7 张。</span>
      </div>
    </div>
  </div>
`);
