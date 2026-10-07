import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/useAuth';
import Layout from './components/Layout';
import LoadError from './components/LoadError';
import Login, { PortalLogin } from './pages/Login';
import Dashboard from './pages/Dashboard';
import BulkUpload from './pages/BulkUpload';
import ManualEntry from './pages/ManualEntry';
import Inventory from './pages/Inventory';
import MakeRequest from './pages/MakeRequest';
import ReviewHistory from './pages/ReviewHistory';
import BudgetSummary from './pages/BudgetSummary';
import Actuals from './pages/Actuals';
import AdminSettings from './pages/AdminSettings';
import Notifications from './pages/Notifications';
import Users from './pages/Users';
import AccountSetup from './pages/AccountSetup';
import ChangePassword from './pages/ChangePassword';
import { ForgotAdminPassword, ResetAdminPassword } from './pages/AdminRecovery';

const queryClient = new QueryClient();

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function ProtectedRoute({ children }) {
  const { user, loading, sessionError, retrySession } = useAuth();
  if (loading) return <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>Loading...</div>;
  if (sessionError) return <LoadError error={sessionError} onRetry={retrySession} />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.needs_account_setup) return <Navigate to="/account-setup" replace />;
  if (user.must_change_password) return <Navigate to="/change-password" replace />;
  return children;
}

function AdminRoute({ children, global = false }) {
  const { isAdmin, isGlobalAdmin } = useAuth();
  if (!(global ? isGlobalAdmin : isAdmin)) return <Navigate to="/dashboard" replace />;
  return children;
}

function SiteUserRoute({ children }) {
  const { isSiteUser } = useAuth();
  if (!isSiteUser) return <Navigate to="/review" replace />;
  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ScrollToTop />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/login/admin" element={<PortalLogin key="admin" role="admin" />} />
            <Route path="/login/site" element={<PortalLogin key="site" role="project_site" />} />
            <Route path="/account-setup" element={<AccountSetup />} />
            <Route path="/forgot-password" element={<ForgotAdminPassword />} />
            <Route path="/reset-password" element={<ResetAdminPassword />} />
            <Route path="/change-password" element={<ChangePassword />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="bulk-upload" element={<AdminRoute><BulkUpload /></AdminRoute>} />
              <Route path="manual-entry" element={<AdminRoute><ManualEntry /></AdminRoute>} />
              <Route path="inventory" element={<Inventory />} />
              <Route path="request" element={<SiteUserRoute><MakeRequest /></SiteUserRoute>} />
              <Route path="review" element={<ReviewHistory />} />
              <Route path="budget-summary" element={<BudgetSummary />} />
              <Route path="actuals" element={<Actuals />} />
              <Route path="settings" element={<AdminRoute global><AdminSettings /></AdminRoute>} />
              <Route path="users" element={<AdminRoute global><Users /></AdminRoute>} />
              <Route path="notifications" element={<Notifications />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
