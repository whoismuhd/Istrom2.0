import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/useAuth';
import Layout from './components/Layout';
import Login from './pages/Login';
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

const queryClient = new QueryClient();

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
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
              <Route path="bulk-upload" element={<BulkUpload />} />
              <Route path="manual-entry" element={<ManualEntry />} />
              <Route path="inventory" element={<Inventory />} />
              <Route path="request" element={<MakeRequest />} />
              <Route path="review" element={<ReviewHistory />} />
              <Route path="budget-summary" element={<BudgetSummary />} />
              <Route path="actuals" element={<Actuals />} />
              <Route path="settings" element={<AdminSettings />} />
              <Route path="notifications" element={<Notifications />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
