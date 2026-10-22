window.slideDataMap.set(4, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-cyan-400 font-mono text-sm tracking-[0.3em] mb-2">[ BACKGROUND · 背景与痛点 ]</div>
        <h1 class="text-4xl font-bold text-white">资料"沉而不用"的三个断点</h1>
      </div>
      <div class="grid grid-cols-3 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7 flex flex-col">
          <div class="flex items-center gap-3 mb-4"><div class="w-10 h-10 rounded bg-cyan-500/20 border border-cyan-400 flex items-center justify-center text-cyan-300 font-mono">01</div><h3 class="text-xl font-bold text-cyan-300">报价脱节</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">计划、需求矩阵、测试用例、<span class="text-cyan-300">1580 条</span>历史待办已沉淀，却只用于排期。对外报价仍手工誊抄 Excel（如阜新银行模板即人工产物），<span class="text-cyan-300">不可追溯、无法随计划刷新</span>。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7 flex flex-col">
          <div class="flex items-center gap-3 mb-4"><div class="w-10 h-10 rounded bg-purple-500/20 border border-purple-400 flex items-center justify-center text-purple-300 font-mono">02</div><h3 class="text-xl font-bold text-purple-300">用例零散</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">用例散落文档与口头，<span class="text-purple-300">缺统一库、缺覆盖度度量、缺与需求矩阵的双向溯源</span>。质量保障难以量化，回归范围靠人脑记忆。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7 flex flex-col">
          <div class="flex items-center gap-3 mb-4"><div class="w-10 h-10 rounded bg-amber-500/20 border border-amber-400 flex items-center justify-center text-amber-300 font-mono">03</div><h3 class="text-xl font-bold text-amber-300">资料不转化</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">PRD / 矩阵 / 计划 / 用例沉淀后，<span class="text-amber-300">启动会材料仍靠人工拼装 PPT</span>，耗时且风格不一。一次启动会往往重做数小时排版。</p>
        </div>
      </div>
      <div class="mt-6 flex items-center gap-6 px-6 py-4 bg-slate-900/70 border-l-4 border-cyan-400 rounded">
        <span class="text-cyan-300 font-mono text-sm">现状证据</span>
        <span class="text-slate-300 text-[15px]">mtask四期 12 条需求(high 10 / normal 2) · 工期 normal avg 1.75 天 · milestone avg 7.0 天 · 结论：资料已够，只差"转化能力"</span>
      </div>
    </div>
  </div>
`);
