window.slideDataMap.set(18, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-cyan-400 font-mono text-sm tracking-[0.3em] mb-2">[ PRACTICE · 使用流程 ]</div>
        <h1 class="text-4xl font-bold text-white">一次点击，资料 → 成稿</h1>
      </div>
      <div class="grid grid-cols-3 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/40 rounded-xl p-8 flex flex-col relative">
          <div class="text-cyan-400 font-mono text-6xl font-bold opacity-30 absolute top-4 right-6">01</div>
          <div class="w-14 h-14 rounded-full bg-cyan-500/20 border-2 border-cyan-400 flex items-center justify-center text-cyan-300 text-2xl font-bold mb-5">①</div>
          <h3 class="text-2xl font-bold text-cyan-300 mb-3">选资料</h3>
          <p class="text-slate-300 text-[16px] leading-relaxed">在 KickoffPptPanel 勾选要纳入的 <span class="text-cyan-300">PRD / 计划 / 用例</span>；Preflight 校验资料齐备性。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/40 rounded-xl p-8 flex flex-col relative">
          <div class="text-purple-400 font-mono text-6xl font-bold opacity-30 absolute top-4 right-6">02</div>
          <div class="w-14 h-14 rounded-full bg-purple-500/20 border-2 border-purple-400 flex items-center justify-center text-purple-300 text-2xl font-bold mb-5">②</div>
          <h3 class="text-2xl font-bold text-purple-300 mb-3">点生成</h3>
          <p class="text-slate-300 text-[16px] leading-relaxed">点击卡片触发 <span class="font-mono text-purple-300">SSE 流</span>；版式断言保障规范，进度与 glow 光晕实时可见。</p>
        </div>
        <div class="bg-slate-800/70 border border-emerald-500/40 rounded-xl p-8 flex flex-col relative">
          <div class="text-emerald-400 font-mono text-6xl font-bold opacity-30 absolute top-4 right-6">03</div>
          <div class="w-14 h-14 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center text-emerald-300 text-2xl font-bold mb-5">③</div>
          <h3 class="text-2xl font-bold text-emerald-300 mb-3">得 .pptx</h3>
          <p class="text-slate-300 text-[16px] leading-relaxed">下载 <span class="text-emerald-300">12~18 页</span>原生 pptx，可继续编辑；无需任何手工排版。</p>
        </div>
      </div>
      <div class="mt-6 flex items-center justify-center gap-4 text-[17px] font-mono">
        <span class="px-4 py-2 bg-slate-900/70 border border-cyan-500/40 rounded text-cyan-300">选资料</span>
        <span class="text-purple-400">→</span>
        <span class="px-4 py-2 bg-slate-900/70 border border-purple-500/40 rounded text-purple-300">点生成</span>
        <span class="text-emerald-400">→</span>
        <span class="px-4 py-2 bg-slate-900/70 border border-emerald-500/40 rounded text-emerald-300">得成稿</span>
      </div>
    </div>
  </div>
`);
