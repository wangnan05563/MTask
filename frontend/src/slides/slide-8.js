window.slideDataMap.set(8, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-8">
        <div class="text-cyan-400 font-mono text-sm tracking-[0.3em] mb-2">[ P4 · PERT 引擎 ]</div>
        <h1 class="text-4xl font-bold text-white">PERT 计算与汇总引擎</h1>
      </div>
      <div class="flex items-stretch justify-between gap-3 mb-8">
        <div class="flex-1 bg-slate-800/80 border-2 border-cyan-400 rounded-xl p-5 text-center">
          <div class="text-cyan-300 font-mono text-xs mb-2">INPUT</div>
          <div class="text-white text-[18px] font-bold">三点 O / M / P</div>
          <div class="text-slate-400 text-[13px] mt-1">逐条计划录入</div>
        </div>
        <div class="flex items-center text-cyan-400 text-3xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-purple-400 rounded-xl p-5 text-center">
          <div class="text-purple-300 font-mono text-xs mb-2">E</div>
          <div class="text-white text-[18px] font-bold">(O+4M+P)/6</div>
          <div class="text-slate-400 text-[13px] mt-1">期望值</div>
        </div>
        <div class="flex items-center text-purple-400 text-3xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-amber-400 rounded-xl p-5 text-center">
          <div class="text-amber-300 font-mono text-xs mb-2">σ</div>
          <div class="text-white text-[18px] font-bold">(P−O)/6</div>
          <div class="text-slate-400 text-[13px] mt-1">标准差</div>
        </div>
        <div class="flex items-center text-amber-400 text-3xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-blue-400 rounded-xl p-5 text-center">
          <div class="text-blue-300 font-mono text-xs mb-2">CI</div>
          <div class="text-white text-[18px] font-bold">置信区间</div>
          <div class="text-slate-400 text-[13px] mt-1">不确定度</div>
        </div>
        <div class="flex items-center text-blue-400 text-3xl">→</div>
        <div class="flex-1 bg-slate-800/80 border-2 border-emerald-400 rounded-xl p-5 text-center">
          <div class="text-emerald-300 font-mono text-xs mb-2">Σ</div>
          <div class="text-white text-[18px] font-bold">阶段人月</div>
          <div class="text-slate-400 text-[13px] mt-1">汇总报价</div>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-5 flex-1">
        <div class="bg-slate-900/70 border-l-4 border-cyan-400 rounded p-5"><h4 class="text-cyan-300 font-bold mb-2">汇总口径</h4><p class="text-slate-300 text-[15px] leading-relaxed">最终估算 → 阶段人月 → 调节系数 → 实际预估人月，<span class="text-cyan-300">复刻客户模板 R35~R40</span>。</p></div>
        <div class="bg-slate-900/70 border-l-4 border-purple-400 rounded p-5"><h4 class="text-purple-300 font-bold mb-2">按阶段汇总</h4><p class="text-slate-300 text-[15px] leading-relaxed">按需求/设计/开发/实施等<span class="text-purple-300">阶段</span>聚合，单条粒度不足以直接报价。</p></div>
        <div class="bg-slate-900/70 border-l-4 border-amber-400 rounded p-5"><h4 class="text-amber-300 font-bold mb-2">排除规则</h4><p class="text-slate-300 text-[15px] leading-relaxed"><span class="text-amber-300">排除小计行</span>、里程碑不进 Σ，前端求和须 ≈ 模板 H35。</p></div>
      </div>
    </div>
  </div>
`);
