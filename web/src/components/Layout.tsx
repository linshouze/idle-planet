import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { App as AntApp, Dropdown, Form, Input, Modal } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { patch, post } from '../api/client';
import { useAct, useAuth } from '../auth';
import { Logo } from './Art';

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {d}
  </svg>
);
const ICONS = {
  home: icon(<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />),
  publish: icon(<><path d="M12 5v14M5 12h14" /><rect x="3.5" y="3.5" width="17" height="17" rx="4" /></>),
  deals: icon(<><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8 12.5l2.7 2.7L16 9.5" /></>),
  requests: icon(<><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" /></>),
  admin: icon(<><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>),
  wishes: icon(<><path d="M12 3l2.2 5.6L20 10l-4.5 3.8L17 20l-5-3.2L7 20l1.5-6.2L4 10l5.8-1.4z" /></>),
  logout: icon(<><path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9" /></>),
  bell: icon(<><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z" /><path d="M10 21h4" /></>),
  search: icon(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>),
};

function Search() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [value, setValue] = useState(params.get('q') ?? '');
  const submit = () => {
    const q = value.trim();
    navigate(q ? `/?q=${encodeURIComponent(q)}` : '/');
  };
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {ICONS.search}
      <input name="q" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="搜索商品，例如「显示器」" aria-label="搜索商品" maxLength={50} />
    </form>
  );
}

function ContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const act = useAct();
  const [form] = Form.useForm<{ contact: string }>();
  return (
    <Modal
      title="我的联系方式"
      open={open}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
      onOk={async () => {
        const v = await form.validateFields();
        if (await act(() => patch('/api/me', v), '联系方式已保存')) onClose();
      }}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        只有交易双方在卖家确认后才能互相看到，其他同事看不到。建议填写飞书 ID 或手机号。
      </p>
      <Form form={form} layout="vertical" initialValues={{ contact: user.contact ?? '' }}>
        <Form.Item name="contact" label="联系方式" rules={[{ required: true, message: '请填写联系方式' }]}>
          <Input maxLength={100} placeholder="例如：飞书 ID、手机号" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function Layout() {
  const { user, badge, wishUpdates } = useAuth();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [contactOpen, setContactOpen] = useState(false);

  const logout = async () => {
    try {
      await post('/api/auth/logout');
    } catch {
      message.error('退出失败，请重试');
      return;
    }
    qc.clear();
    window.location.assign('/');
  };

  return (
    <div className="frame">
      <aside className="side">
        <div className="side-logo">
          <Logo />
          <div className="app-name">闲置星球</div>
          <div className="slogan">让闲置流转起来</div>
        </div>
        <nav className="nav" aria-label="主导航">
          <NavLink to="/" end className={({ isActive }) => `nv${isActive ? ' on' : ''}`}>
            {ICONS.home}首页
          </NavLink>
          <NavLink to="/publish" className={({ isActive }) => `nv${isActive ? ' on' : ''}`}>
            {ICONS.publish}发布商品
          </NavLink>
          <NavLink to="/wishes" className={({ isActive }) => `nv${isActive ? ' on' : ''}`}>
            {ICONS.wishes}心愿墙
            {wishUpdates > 0 && <span className="nv-badge">{wishUpdates}</span>}
          </NavLink>
          <NavLink to="/my/items" className={({ isActive }) => `nv${isActive ? ' on' : ''}`}>
            {ICONS.deals}我的发布
            {badge.toReview + badge.toDeliver > 0 && <span className="nv-badge">{badge.toReview + badge.toDeliver}</span>}
          </NavLink>
          <NavLink to="/my/requests" className={({ isActive }) => `nv${isActive ? ' on' : ''}`}>
            {ICONS.requests}我的申请
            {badge.toConfirm > 0 && <span className="nv-badge">{badge.toConfirm}</span>}
          </NavLink>
          {user.role === 'admin' && (
            <NavLink to="/admin" className={({ isActive }) => `nv${isActive ? ' on' : ''}`}>
              {ICONS.admin}管理后台
            </NavLink>
          )}
        </nav>
        <div className="side-foot">
          <button className="nv" onClick={logout}>
            {ICONS.logout}退出登录
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Search />
          <div className="top-right">
            <button className="bell" aria-label={`待处理 ${badge.total} 项`} title="待处理事项" onClick={() => navigate(badge.toConfirm > 0 && badge.toReview + badge.toDeliver === 0 ? '/my/requests' : '/my/items')}>
              {ICONS.bell}
              {badge.total > 0 && <span className="dot" />}
            </button>
            <Dropdown
              menu={{
                items: [
                  { key: 'contact', label: user.contact ? '修改联系方式' : '填写联系方式' },
                  { key: 'logout', label: '退出登录' },
                ],
                onClick: ({ key }) => (key === 'contact' ? setContactOpen(true) : logout()),
              }}
            >
              <button className="uchip">
                <span className="ava">{user.name.slice(0, 1)}</span>
                {user.name}
              </button>
            </Dropdown>
          </div>
        </header>
        <Outlet />
      </div>
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />
      {!user.contact && <NeedContact onFill={() => setContactOpen(true)} />}
    </div>
  );
}

/** 没有联系方式时不能发布或申请，所以登录后主动提示一次。 */
function NeedContact({ onFill }: { onFill: () => void }) {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('contact-hint') === '1');
  if (dismissed) return null;
  return (
    <Modal
      open
      title="先填写联系方式"
      okText="现在填写"
      cancelText="稍后"
      onOk={() => {
        setDismissed(true);
        onFill();
      }}
      onCancel={() => {
        sessionStorage.setItem('contact-hint', '1');
        setDismissed(true);
      }}
    >
      发布商品和申请商品都需要联系方式。卖家确认交易对象后，双方才能互相看到。
    </Modal>
  );
}
