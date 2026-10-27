import React from 'react';

/**
 * 全局错误边界。
 *
 * 为什么必须有：React 组件 render 期抛错会卸载整个组件树。
 * 在此之前本项目没有任何边界，任何一处未防御的渲染异常（例如读了一个
 * undefined 的 .length）都会让整页变白——用户看到的就是"点一下应用没了"，
 * 而真正的故障点只是一个面板。
 */

interface State {
  failed: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { failed: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { failed: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 保留堆栈：这是定位"哪个组件哪一行炸了"的唯一线索
    console.error('[ErrorBoundary] 渲染异常:', error, info?.componentStack || '');
  }

  handleReload = () => {
    // 用 location.reload 而非重启应用：错误边界通常在渲染层，
    // 主进程状态未损坏，重载页面即可恢复。
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground p-8">
        <div className="max-w-lg w-full rounded-xl border border-border bg-card p-6 shadow-lg">
          <h1 className="text-base font-semibold text-rose-400 mb-2">界面渲染出错</h1>
          <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
            应用遇到无法恢复的渲染错误，已停止绘制界面。你的会话与文件不会丢失。
          </p>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-secondary/30 rounded-md p-3 mb-4 max-h-48 overflow-auto">
            {msg}
          </pre>
          <button
            type="button"
            onClick={this.handleReload}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
          >
            重新加载界面
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
