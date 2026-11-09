import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { UNAUTHORIZED_EVENT } from './api/client';
import { AuthProvider, useAuth, useMeQuery } from './auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { Admin } from './pages/Admin';
import { ItemDetail } from './pages/ItemDetail';
import { Login } from './pages/Login';
import { Market } from './pages/Market';
import { MyItems, MyRequests } from './pages/MyPages';
import { Publish } from './pages/Publish';
import { PublishBatch } from './pages/PublishBatch';
import { Wishes } from './pages/Wishes';
import { Leaderboard } from './pages/Leaderboard';

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  const me = useMeQuery();
  const qc = useQueryClient();

  // 会话过期或被停用时，任何接口返回 401 都回到登录页。
  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  if (me.isLoading) return <div className="login-page"><Spin size="large" /></div>;
  if (me.isError) return <div className="login-page"><div className="empty"><b>无法连接服务器</b>{me.error.message}</div></div>;
  if (!me.data) return <Login />;

  return (
    <AuthProvider me={me.data}>
      <ErrorBoundary>
      <BrowserRouter>
        <ScrollTop />
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Market />} />
            <Route path="items/:id" element={<ItemDetail />} />
            <Route path="items/:id/edit" element={<Publish />} />
            <Route path="publish" element={<Publish />} />
            <Route path="publish/batch" element={<PublishBatch />} />
            <Route path="wishes" element={<Wishes />} />
            <Route path="leaderboard" element={<Leaderboard />} />
            <Route path="my/items" element={<MyItems />} />
            <Route path="my/requests" element={<MyRequests />} />
            <Route path="admin" element={<AdminOnly><Admin /></AdminOnly>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </ErrorBoundary>
    </AuthProvider>
  );
}
