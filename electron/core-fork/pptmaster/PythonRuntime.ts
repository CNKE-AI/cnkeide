/**
 * PPT Master 的 Python 运行时入口 —— 实现已抽到通用模块。
 *
 * 抽离原因：run_python 等通用开发能力同样需要「配置 / 项目 venv / 内置 / 系统」
 * 的解析链，继续把它锁在 PPT Master 目录下会导致两份探测逻辑各自腐化。
 * 这里仅做转发，保持既有 import 路径与调用签名不变。
 */
export {
  resolvePython,
  clearPythonCache,
  checkDependencies,
  installDependencies,
  PYPI_MIRROR,
} from '../python/PythonRuntime';
export type { PythonInfo, DependencyStatus } from '../python/PythonRuntime';
