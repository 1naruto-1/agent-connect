import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

// 先写临时文件再重命名, 中途崩溃或磁盘写满不会留下半截会话文件
export function atomicWriteFileSync(file: string, data: string): void {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
