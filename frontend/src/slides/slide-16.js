window.slideDataMap.set(16, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ P5 · 前端交互 ]</div>
        <h1 class="text-4xl font-bold text-white">KickoffPptPanel 交互</h1>
      </div>
      <div class="flex-1 bg-slate-900 border border-cyan-500/40 rounded-xl overflow-hidden flex flex-col">
        <div class="flex items-center gap-2 px-4 py-3 bg-slate-800 border-b border-slate-700">
          <div class="w-3 h-3 rounded-full bg-red-400"></div><div class="w-3 h-3 rounded-full bg-amber-400"></div><div class="w-3 h-3 rounded-full bg-emerald-400"></div>
          <span class="ml-3 text-slate-400 font-mono text-sm">KickoffPptPanel.tsx · 取数映射</span>
        </div>
        <div class="p-7 font-mono text-[15px] leading-8 flex-1">
          <div class="text-cyan-300">// 一次点击，读取五类沉淀资料</div>
          <div class="text-slate-200">const sources = [</div>
          <div class="text-slate-200 pl-6 text-purple-300">"PRD 文档", "需求跟踪矩阵", "项目计划",</div>
          <div class="text-slate-200 pl-6 text-purple-300">"测试用例", "工作空间分析"</div>
          <div class="text-slate-200">];</div>
          <div class="text-cyan-300 mt-3">// AI 组织为章节 → 版式断言 → 装配</div>
          <div class="text-slate-200">const deck = await assembleKickoff(sources);</div>
          <div class="text-emerald-300 mt-3">// 产物：可继续编辑的原生 .pptx</div>
          <div class="text-slate-200">// 含 甘特 / 工作量 / 风险 / 沟通管理</div>
          <div class="text-amber-300 mt-3">// 生成中 glow 光晕 · 进度可见</div>
        </div>
      </div>
      <div class="mt-5 flex items-center gap-4 px-6 py-4 bg-slate-900/70 border-l-4 border-emerald-400 rounded">
        <span class="text-emerald-300 font-mono text-sm">价值</span>
        <span class="text-slate-300 text-[15px]">把"人工拼装数小时"压缩为"一次点击"，且产物可继续编辑，而非图片死稿。</span>
      </div>
    </div>
  </div>
`);
