window.slideDataMap.set(14, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ P5 · 核心生成引擎 ]</div>
        <h1 class="text-4xl font-bold text-white">核心生成引擎 · 四组件</h1>
        <p class="text-slate-400 text-[16px] mt-2">新增的是"内容装配器"，不是新的 PPT 引擎</p>
      </div>
      <div class="grid grid-cols-2 grid-rows-2 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-cyan-500/20 flex items-center justify-center text-cyan-300 font-mono text-sm">01</div><h3 class="text-xl font-bold text-cyan-300">版式断言层</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">质量门禁（Node 移植技能路径纪律）：<span class="text-cyan-300">每个章节先断言版式</span>，不符则重生成，保证成品规范。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-purple-500/20 flex items-center justify-center text-purple-300 font-mono text-sm">02</div><h3 class="text-xl font-bold text-purple-300">PPT 装配器</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">把 AI 组织的章节<span class="text-purple-300">装配为原生 .pptx</span>（pptxgenjs + worker 池），不引入 reveal/Slidev/Marp。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-amber-500/20 flex items-center justify-center text-amber-300 font-mono text-sm">03</div><h3 class="text-xl font-bold text-amber-300">时间线绘制</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">绘制<span class="text-amber-300">甘特 / 时间线</span>形状，把项目计划可视化为启动会关键视图。</p>
        </div>
        <div class="bg-slate-800/70 border border-emerald-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-emerald-500/20 flex items-center justify-center text-emerald-300 font-mono text-sm">04</div><h3 class="text-xl font-bold text-emerald-300">工作量降级</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">超预算时<span class="text-emerald-300">降级保交付</span>：砍非核心章节、保甘特/工作量/风险/沟通主干。</p>
        </div>
      </div>
    </div>
  </div>
`);
