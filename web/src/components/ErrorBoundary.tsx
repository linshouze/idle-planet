import { Component, type ReactNode } from 'react';
import { Button } from 'antd';

/** 渲染出错时显示提示，而不是整页白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('页面渲染出错', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="login-page">
        <div className="empty">
          <b>页面出错了</b>
          刷新页面可以恢复，已经提交的操作不会丢失。
          <div>
            <Button type="primary" onClick={() => window.location.assign('/')}>
              回到首页
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
