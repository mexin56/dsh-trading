import { defineConfig } from 'tsdown'

// 与 connector-jin10/okx 同款：单步 tsdown（dts: true）。本连接器无 preset 面
// （dataplane 行不适用——它不注册市场行情服务），故只有主入口。
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
