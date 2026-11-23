#!/usr/bin/env node
/**
 * 把仓库里跟踪的安卓原生代码（src-tauri/android/*.kt）同步进生成的 Android 工程。
 *
 * `src-tauri/gen/` 不入库，CI 和换机器都会重新 `tauri android init`；与 sync-android-icons.mjs
 * 一样由 tauri.conf.json 的 beforeBuildCommand 自动调用，gen/android 不存在时（桌面构建）直接跳过。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "android");
// 包路径与 tauri.conf.json 的 identifier（com.hghub.huangguo）一致
const dest = join(root, "src-tauri", "gen", "android", "app", "src", "main", "java", "com", "hghub", "huangguo");

if (!existsSync(join(root, "src-tauri", "gen", "android", "app"))) {
  console.log("[android] 跳过：gen/android 还没生成（先跑 tauri android init）");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src).filter((file) => file.endsWith(".kt"))) {
  copyFileSync(join(src, name), join(dest, name));
  console.log(`[android] 已同步 ${name} → ${dest}`);
}
