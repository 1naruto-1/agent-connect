import readline from 'node:readline/promises';
import { adapters, listAllSessions } from '../adapters/index.ts';
import { migrate } from '../migrate.ts';
import { formatTime } from './list.ts';
import type { Adapter } from '../types.ts';

export async function interactive(): Promise<void> {
  const cwd = process.cwd();
  const sessions = listAllSessions(cwd);
  if (sessions.length === 0) {
    console.log(`当前项目 ${cwd} 没有任何已支持 Harness 的会话。`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const shown = sessions.slice(0, 20);
    console.log(`当前项目的会话（${sessions.length} 个${sessions.length > 20 ? '，显示最近 20 个' : ''}）：\n`);
    shown.forEach((session, index) => console.log(`  ${String(index + 1).padStart(2)}. [${session.source.padEnd(6)}] ${formatTime(session.updatedAt)}  ${session.title}`));
    const picked = shown[Number.parseInt(await rl.question('\n迁移哪个会话？输入编号：'), 10) - 1];
    if (!picked) throw new Error('无效编号');

    const targets: Adapter[] = Object.values(adapters).filter((adapter) => adapter.id !== picked.source && adapter.available());
    if (targets.length === 0) throw new Error('未发现可写入的目标 Harness。');
    console.log('');
    targets.forEach((target, index) => console.log(`  ${index + 1}. ${target.label}`));
    const target = targets[Number.parseInt(await rl.question('\n迁移到哪个 Harness？输入编号：'), 10) - 1];
    if (!target) throw new Error('无效编号');

    let notReady: string | null;
    while ((notReady = target.writeReady())) {
      const retry = await rl.question(`\n${notReady}\n处理好后按回车重试（输入 q 放弃）：`);
      if (retry.trim().toLowerCase() === 'q') return;
    }
    console.log(`\n迁移：[${picked.source}]《${picked.title}》 → ${target.label} ...`);
    const result = migrate(cwd, picked.source, picked.id, target.id);
    console.log(`完成：${result.summary}`);
    console.log(`报告：${result.reportFile}`);
    console.log(`\n继续会话：${result.resumeHint}`);
  } finally {
    rl.close();
  }
}
