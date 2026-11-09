import { useState } from 'react';
import { Button, Form, Input } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../api/client';
import { BannerArt, Logo } from '../components/Art';

export function Login() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const bindMode = params.get('bind') === 'feishu';
  const feishuNotice =
    params.get('feishu') === 'pending'
      ? '飞书授权成功。扫码登录通道联调中，请先用工号登录。'
      : bindMode
        ? '飞书身份已确认，还差一步：输入工号完成绑定，之后扫码即可直接登录。'
        : '';
  const feishuError =
    params.get('err') === 'feishu_state'
      ? '飞书登录状态校验失败，请重试。'
      : params.get('err') === 'feishu_disabled'
        ? '飞书登录未启用，请用工号登录。'
        : params.get('err') === 'feishu_denied'
          ? '飞书授权未完成，请重试或用工号登录。'
          : params.get('err') === 'feishu_failed'
            ? '飞书登录暂时不可用，请用工号登录。'
            : params.get('err') === 'feishu_bound'
              ? '该飞书账号已绑定其他工号，请联系管理员。'
              : '';

  const bindSubmit = async (v: { employeeNo: string }) => {
    setLoading(true);
    setError('');
    try {
      await post('/api/auth/feishu/bind', v);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '绑定失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const submit = async (v: { employeeNo: string }) => {
    setLoading(true);
    setError('');
    try {
      await post('/api/auth/login', v);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <section className="login-hero" aria-hidden="true">
          <h1>闲置星球</h1>
          <p>公司内部闲置物品循环平台</p>
          <BannerArt />
        </section>
        <section className="login-form">
          <Logo size={44} />
          <h2>登录</h2>
          <div className="sub">输入工号登录。没有账号请联系管理员加入白名单。</div>
          <Form layout="vertical" onFinish={submit} requiredMark={false} autoComplete="off">
            <Form.Item name="employeeNo" label="工号" rules={[{ required: true, whitespace: true, message: '请输入工号' }]}>
              <Input size="large" autoFocus maxLength={50} placeholder="例如 E001" />
            </Form.Item>
            {error && (
              <div role="alert" style={{ color: '#dc2626', marginBottom: 12 }}>
                {error}
              </div>
            )}
            <Button type="primary" size="large" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
          {feishuNotice && (
            <div role="status" className="login-notice">
              {feishuNotice}
            </div>
          )}
          {feishuError && !error && (
            <div role="alert" style={{ color: '#dc2626', marginTop: 12 }}>
              {feishuError}
            </div>
          )}
          {bindMode ? (
            <Form layout="vertical" onFinish={bindSubmit} requiredMark={false} autoComplete="off">
              <Form.Item name="employeeNo" label="工号绑定" rules={[{ required: true, whitespace: true, message: '请输入工号' }]}>
                <Input size="large" maxLength={50} placeholder="输入你的工号，例如 E001" />
              </Form.Item>
              <Button size="large" block className="login-feishu-btn" htmlType="submit" loading={loading}>
                绑定并登录
              </Button>
            </Form>
          ) : (
            <>
              <div className="login-divider" aria-hidden="true">
                <span>或</span>
              </div>
              <Button size="large" block className="login-feishu-btn" onClick={() => { window.location.href = '/api/auth/feishu'; }}>
                飞书扫码登录
              </Button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
