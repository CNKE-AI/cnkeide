import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import 'highlight.js/styles/github-dark.css';

// 兜底诊断：渲染层未捕获的异常 / 未处理的 Promise 拒绝。
// 这两类不会触发 ErrorBoundary（只捕获 render/lifecycle 错误），却极易在长任务、
// 大输出、异步回调里出现；统一打成 console.error，主进程会把 error 级别日志
// 落盘到 <userData>/logs/renderer-error.log，白屏后仍有据可查。
window.addEventListener('error', (e) => {
  console.error('[uncaught]', e.message, `${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ''}` : String(e.reason);
  console.error('[unhandled-rejection]', reason);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
