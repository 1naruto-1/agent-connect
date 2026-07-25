import { getAppPaths } from '../platform/paths.ts';

export async function paths(): Promise<void> {
  const locations = getAppPaths();
  console.log(`可执行文件目录：${locations.executableDir}`);
  console.log(`应用数据目录：${locations.dataDir}`);
  console.log(`迁移报告目录：${locations.reportsDir}`);
}
