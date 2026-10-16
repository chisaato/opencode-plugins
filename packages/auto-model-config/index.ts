// OpenCode V2 目录型插件入口。
//
// V2 在加载“目录型插件”时会忽略 package.json 的 main/exports，直接查找
// 插件根目录下的 index.ts / index.js。V1 才按 package.json 的 main 解析。
// 因此这里提供一个根入口，复用 src/index.ts 的真实实现。
export { default, AutoModelConfigPlugin } from "./src/index"
