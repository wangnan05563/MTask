// T00908 UI 测试辅助：在 MTask 项目写入一份 PRD 文档，供倾斜按钮弹层测试
const doc = {
  projectId: '1ca54445-192d-4664-b495-f1830eb9b8e4',
  filename: 'T00908-UI测试PRD',
  contentMd: '# T00908 UI 测试\n\n## 需求一\n自动关联验证需求\n\n## 需求二\n倾斜按钮验证需求',
};
const r = await fetch('http://127.0.0.1:39876/api/plans/prd-docs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(doc),
});
const d = await r.json();
console.log('CREATED', d.id, '|', d.filename, '| status', r.status);