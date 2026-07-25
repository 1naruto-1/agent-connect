// 交互式迁移: 选会话 → 选目标工具 → 完成
import readline from 'node:readline/promises';
import { listAllSessions, adapters } from '../adapters/index.js';
import { migrate } from '../migrate.js';
import { formatTime } from './list.js';

export async function interactive() {
  const cwd = process.cwd();
  const sessions = listAllSessions(cwd);
  if (sessions.length === 0) {
    console.log(`当前项目 ${cwd} 没有任何工具的会话。`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const shown = sessions.slice(0, 20);
    console.log(`当前项目的会话 (${sessions.length} 个${sessions.length > 20 ? ', 显示最近 20 个' : ''}):\n`);
    shown.forEach((s, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. [${s.source.padEnd(6)}] ${formatTime(s.updatedAt)}  ${s.title}`);
    });
    const pick = await rl.question('\n迁移哪个会话? 输入编号: ');
    const session = shown[parseInt(pick, 10) - 1];
    if (!session) throw new Error('无效编号');

    const targets = Object.values(adapters).filter((a) => a.id !== session.source && a.available());
    console.log('');
    targets.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`));
    const tpick = await rl.question('\n迁移到哪个工具? 输入编号: ');
    const target = targets[parseInt(tpick, 10) - 1];
    if (!target) throw new Error('无效编号');

    // 目标端写入前置检查不通过时 (如 Cursor 未退出), 提示后等用户处理再继续
    let notReady;
    while ((notReady = target.writeReady())) {
      const retry = await rl.question(`\n${notReady}\n处理好后按回车重试 (输入 q 放弃): `);
      if (retry.trim().toLowerCase() === 'q') return;
    }

    console.log(`\n迁移: [${session.source}]《${session.title}》 → ${target.label} ...`);
    const r = migrate(cwd, session.source, session.id, target.id);
    console.log(`完成: ${r.summary}`);
    console.log(`报告: ${r.reportFile}`);
    console.log(`\n继续会话: ${r.resumeHint}`);
  } finally {
    rl.close();
  }
}
