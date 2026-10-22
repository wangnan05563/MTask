window.slideDataMap.set(20, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ CAUTION · 边界 ]</div>
        <h1 class="text-4xl font-bold text-white">注意事项与边界</h1>
      </div>
      <div class="grid grid-cols-2 grid-rows-2 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-cyan-500/20 flex items-center justify-center text-cyan-300 font-mono text-sm">✕</div><h3 class="text-xl font-bold text-cyan-300">非目标</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">四期<span class="text-cyan-300">不做</span>资源费率管理 / 财务核算 / 跨项目组合（Portfolio）汇总；五期<span class="text-cyan-300">不做</span>新 PPT 引擎，只做内容装配器。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-purple-500/20 flex items-center justify-center text-purple-300 font-mono text-sm">↓</div><h3 class="text-xl font-bold text-purple-300">降级策略</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">长文 AI 输出受 <span class="font-mono text-purple-300">max_tokens</span> 易截断 → 抬预算 / 分章；版式断言层做质量门禁，不符则重生成。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-amber-500/20 flex items-center justify-center text-amber-300 font-mono text-sm">!</div><h3 class="text-xl font-bold text-amber-300">风险提示</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed"><span class="text-amber-300">并发闸</span>防流式生成打满资源；缺料时 Preflight 硬阻塞，需先补齐资料再生成。</p>
        </div>
        <div class="bg-slate-800/70 border border-emerald-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-emerald-500/20 flex items-center justify-center text-emerald-300 font-mono text-sm">✓</div><h3 class="text-xl font-bold text-emerald-300">审批状态</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">四期 PRD（估算/导出/测试）<span class="text-emerald-300">已批准 v1.3</span>；五期 PRD（启动会 PPT）<span class="text-emerald-300">草案待审批 v1.0</span>，以 WBS 为权威轨。</p>
        </div>
      </div>
    </div>
  </div>
`);
