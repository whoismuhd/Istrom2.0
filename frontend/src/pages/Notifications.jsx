import { useEffect, useState } from 'react';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../api';
import { pushSupported, deviceNotificationsEnabled, enablePush, disablePush } from '../push';
import './Notifications.css';

function getBadgeClass(type) {
  if (type === 'request_approved') return 'approved';
  if (type === 'request_rejected') return 'rejected';
  if (type === 'request_submitted') return 'submitted';
  if (type === 'new_request') return 'new_request';
  return 'pending';
}

export default function Notifications() {
  const queryClient = useQueryClient();
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState('');

  useEffect(() => {
    if (!pushSupported()) return;
    deviceNotificationsEnabled().then(setPushOn).catch(() => {});
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    setPushMsg('');
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
        setPushMsg('Device notifications turned off.');
      } else {
        const res = await enablePush();
        if (res.ok) {
          setPushOn(true);
          setPushMsg('Device notifications enabled.');
        } else {
          setPushMsg(res.reason || 'Could not enable notifications.');
        }
      }
    } catch (err) {
      setPushMsg(err?.message || 'Could not update notification settings.');
    } finally {
      setPushBusy(false);
    }
  };

  const { data: notifications = [], error: loadError, isLoading, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list(),
  });

  const markReadMutation = useMutation({
    mutationFn: (id) => api.notifications.markRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const hasDetails = (n) => n.item_name || n.budget || n.building_subtype;

  if (loadError) return <LoadError error={loadError} onRetry={() => refetch()} />;
  if (isLoading) return <div className="card" role="status">Loading...</div>;

  return (
    <div className="notifications-page">
      <div className="card">
        <h1>Notifications</h1>
        <ErrorMessage error={markReadMutation.error} />

        {pushSupported() && (
          <div className="push-toggle-row">
            <button className="btn btn-secondary btn-sm" onClick={togglePush} disabled={pushBusy}>
              {pushBusy ? 'Working…' : pushOn ? 'Disable device notifications' : 'Enable device notifications'}
            </button>
            {pushMsg && <span className="push-toggle-hint" role="status">{pushMsg}</span>}
          </div>
        )}

        {notifications.length === 0 && (
          <p className="notifications-empty">No notifications yet.</p>
        )}

        <div className="notifications-list">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`notification-item ${n.is_read ? 'read' : 'unread'} type-${getBadgeClass(n.notification_type)}`}
              onClick={() => !n.is_read && markReadMutation.mutate(n.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && !n.is_read && markReadMutation.mutate(n.id)}
            >
              <div className="notification-main">
                <h4 className="notification-title">{n.title}</h4>
                <p className="notification-message">{n.message}</p>
                {hasDetails(n) && (
                  <div className="notification-details">
                    {n.item_name && (
                      <span className="notification-detail">
                        <strong>Item:</strong> {n.item_name}
                        {n.qty != null && ` × ${n.qty}`}
                      </span>
                    )}
                    {n.budget && (
                      <span className="notification-detail notification-detail-budget">
                        <strong>Budget:</strong> {n.budget}
                      </span>
                    )}
                    {n.building_subtype && (
                      <span className="notification-detail">
                        <strong>Building:</strong> {n.building_subtype}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="notification-meta">
                <span className={`notification-badge ${getBadgeClass(n.notification_type)}`}>
                  {n.notification_type.replace(/_/g, ' ')}
                </span>
                <span className="notification-time">
                  {n.created_at ? formatDate(n.created_at) : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
