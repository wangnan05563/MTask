/**
 * T05689：SonarQube Basic 认证头的单源实现。
 *
 * SonarQube / SonarCloud 的 user token 认证约定是「**token 作为用户名、密码留空**」，
 * 即凭据串必须是 `${token}:`。少了这个冒号，base64 解出来是裸 token，
 * 服务端按 `用户名:密码` 解析拿不到合法用户名 → 一律 401（而不是 403）。
 *
 * 背景：设置页「从服务器读取 project Key」与扫描侧取数原来各写一份 Authorization 构造，
 * 设置页那份漏了冒号 → 同一台服务器「扫描能跑、读项目列表 401」。共用本函数后不再有第二份。
 */

/** 粘贴容错：去掉 `Bearer ` 前缀、首尾引号/反引号与空白（token 常被整段粘贴进来） */
export function normalizeSonarToken(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
}

/** 生成 `Authorization: Basic ...` 头值（token 作用户名、密码留空） */
export function sonarBasicAuth(token: string): string {
  return `Basic ${Buffer.from(`${normalizeSonarToken(token)}:`).toString('base64')}`;
}
