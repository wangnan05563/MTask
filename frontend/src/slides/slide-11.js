window.slideDataMap.set(11, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-8">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ P4 · AI 生成链路 ]</div>
        <h1 class="text-4xl font-bold text-white">AI 生成链路与 MCP 工具</h1>
      </div>
      <div class="flex items-center justify-between gap-2 mb-8">
        <div class="flex-1 bg-slate-800/80 border-2 border-cyan-400 rounded-xl p-5 text-center"><div class="text-cyan-300 font-mono text-xs mb-1">INPUT</div><div class="text-white text-[17px] font-bold">PRD / 外部导入</div></div>
        <div class="text-cyan-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-purple-400 rounded-xl p-5 text-center"><div class="text-purple-300 font-mono text-xs mb-1">SERVICE</div><div class="text-white text-[17px] font-bold">TestCaseGenService</div></div>
        <div class="text-purple-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-amber-400 rounded-xl p-5 text-center"><div class="text-amber-300 font-mono text-xs mb-1">DRAFT</div><div class="text-white text-[17px] font-bold">草稿确认视图</div></div>
        <div class="text-amber-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-blue-400 rounded-xl p-5 text-center"><div class="text-blue-300 font-mono text-xs mb-1">IMPORT</div><div class="text-white text-[17px] font-bold">确认导入</div></div>
        <div class="text-blue-400 text-2xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-emerald-400 rounded-xl p-5 text-center"><div class="text-emerald-300 font-mono text-xs mb-1">MCP</div><div class="text-white text-[17px] font-bold">mtask_* 暴露</div></div>
      </div>
      <div class="grid grid-cols-2 gap-5 flex-1">
        <div class="bg-slate-900/70 border-l-4 border-cyan-400 rounded p-5"><h4 class="text-cyan-300 font-bold mb-2">草稿优先</h4><p class="text-slate-300 text-[15px] leading-relaxed">AI 生成用例<span class="text-cyan-300">草稿</span>，人工确认后再导入，避免误写库；会话状态保持可续编。</p></div>
        <div class="bg-slate-900/70 border-l-4 border-amber-400 rounded p-5"><h4 class="text-amber-300 font-bold mb-2">降级约束</h4><p class="text-slate-300 text-[15px] leading-relaxed">长文输出受 <span class="font-mono text-amber-300">max_tokens</span> 易截断 → 需抬预算 / 分章；复用既有 report-worker 池调度。</p></div>
      </div>
    </div>
  </div>
`);
