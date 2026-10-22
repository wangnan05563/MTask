window.slideDataMap.set(10, `
  <div class="w-[1440px] h-[810px] shadow-2xl relative overflow-hidden slide-bg">
    <div class="absolute inset-0" style="background-image: linear-gradient(rgba(56,189,248,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.06) 1px, transparent 1px); background-size: 48px 48px;"></div>
    <div class="w-[1350px] h-[720px] mx-auto my-[45px] flex flex-col relative z-10">
      <div class="mb-6">
        <div class="text-amber-400 font-mono text-sm tracking-[0.3em] mb-2">[ P4 · 测试用例管理 ]</div>
        <h1 class="text-4xl font-bold text-white">测试用例管理模块</h1>
        <p class="text-slate-400 text-[16px] mt-2">从零散 → 结构化库，并打通需求矩阵溯源</p>
      </div>
      <div class="grid grid-cols-2 grid-rows-2 gap-6 flex-1">
        <div class="bg-slate-800/70 border border-cyan-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-cyan-500/20 flex items-center justify-center text-cyan-300 font-mono text-sm">A</div><h3 class="text-xl font-bold text-cyan-300">数据模型</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">新增 <span class="font-mono text-cyan-300">test_cases</span> + <span class="font-mono text-cyan-300">case_steps</span> 步骤子表；枚举常量服务端单源，前后端共用。</p>
        </div>
        <div class="bg-slate-800/70 border border-purple-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-purple-500/20 flex items-center justify-center text-purple-300 font-mono text-sm">B</div><h3 class="text-xl font-bold text-purple-300">CRUD 与批量</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">用例增删改查 + <span class="text-purple-300">批量操作</span>（静态路径优先于 /:id）；导出接口齐备。</p>
        </div>
        <div class="bg-slate-800/70 border border-amber-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-amber-500/20 flex items-center justify-center text-amber-300 font-mono text-sm">C</div><h3 class="text-xl font-bold text-amber-300">覆盖度度量</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">按 P0~P3 优先级统计覆盖；参考基线 swork <span class="text-amber-300">71 条</span>用例（P0 9 / P1 31 / P2 25 / P3 6）。</p>
        </div>
        <div class="bg-slate-800/70 border border-emerald-500/30 rounded-xl p-7">
          <div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded bg-emerald-500/20 flex items-center justify-center text-emerald-300 font-mono text-sm">D</div><h3 class="text-xl font-bold text-emerald-300">矩阵双向跳转</h3></div>
          <p class="text-slate-300 text-[16px] leading-relaxed">需求跟踪矩阵 <span class="text-emerald-300">⇄</span> 用例视图双向跳转，每条用例可溯源到需求编号。</p>
        </div>
      </div>
    </div>
  </div>
`);
