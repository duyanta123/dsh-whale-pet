// 兼容壳：契约单源已移至 lib/client/assets-manifest.mjs（浏览器经 /api/whale-pet/client/* 同源装载，
// 父级相对导入会被浏览器 URL 规范化破坏——见附录 B）。本文件仅为既有导入面保留。
export * from "./client/assets-manifest.mjs"
