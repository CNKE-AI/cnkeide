import React from 'react';
import ReactDOM from 'react-dom/client';
import PptPage from './pages/PptPage';
import ErrorBoundary from './components/ErrorBoundary';
import { AppProvider } from './store/AppProvider';
import './index.css';

// 与主入口 main.tsx 对齐：PPT 独立页此前没有错误边界与全局兜底，
// 扫描/生成结果渲染一旦抛错就是整页白屏且无日志可查。
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
      <AppProvider>
        <PptPage />
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
