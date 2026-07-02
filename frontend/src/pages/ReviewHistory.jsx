import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatDate } from '../api';

export default function ReviewHistory() {
  const { isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState('Pending');
  const [historyTab, setHistoryTab] = useState(isAdmin ? 'approved' : 'pending'); // pending | approved | rejected | deleted (deleted only for admin)
  const activeHistoryTab = isAdmin && historyTab === 'pending' ? 'approved' : historyTab;
  const [bulkIds, setBulkIds] = useState('');
  const [bulkAction, setBulkAction] = useState('Approved');
  const [bulkApprovedBy, setBulkApprovedBy] = useState('');

  const params = { project_site: getEffectiveProjectSite() };
  if (isAdmin && statusFilter) params.status = statusFilter;

  const { data: requests = [] } = useQuery({
    queryKey: ['requests', params],
    queryFn: () => api.requests.list(params),
  });

  const { data: deleted = [] } = useQuery({
    queryKey: ['deletedRequests'],
    queryFn: () => api.deletedRequests.list(),
    enabled: isAdmin,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.requests.updateStatus(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.requests.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['deletedRequests'] });
    },
  });

  const clearDeletedMutation = useMutation({
    mutationFn: () => api.deletedRequests.clear(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deletedRequests'] }),
  });

  const handleApprove = (req) => {
    updateMutation.mutate({
      id: req.id,
      data: { status: 'Approved', approved_by: 'Admin' },
    });
  };

  const handleReject = (req) => {
    updateMutation.mutate({
      id: req.id,
      data: { status: 'Rejected', approved_by: 'Admin' },
    });
  };

  const handleBulkSubmit = () => {
    const ids = bulkIds.split(/[\s,]+/).filter(Boolean).map(Number);
    ids.forEach((id) => {
      updateMutation.mutate({
        id,
        data: { status: bulkAction, approved_by: bulkApprovedBy || 'Admin' },
      });
    });
    setBulkIds('');
  };

  const pending = requests.filter((r) => r.status === 'Pending');
  const approved = requests.filter((r) => r.status === 'Approved');
  const rejected = requests.filter((r) => r.status === 'Rejected');

  const getStatusBadge = (s) => {
    const c = s === 'Pending' ? 'badge-pending' : s === 'Approved' ? 'badge-approved' : 'badge-rejected';
    return <span className={`badge ${c}`}>{s}</span>;
  };

  return (
    <div className="review-history-page">
      {isAdmin && (
      <div className="card">
        <div className="review-header">
          <div>
            <h2>Review & History</h2>
            <p className="caption">Pending requests, approve/reject, and history</p>
          </div>
          <div className="form-group form-group-compact">
            <label>Status Filter</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              <option value="Pending">Pending</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
            </select>
          </div>
        </div>

        {pending.length > 0 && (
          <div className="bulk-actions card">
            <h3>Bulk Actions</h3>
            <div className="form-row">
              <div className="form-group form-group-wide">
                <label>Request IDs (comma-separated)</label>
                <input value={bulkIds} onChange={(e) => setBulkIds(e.target.value)} placeholder="e.g. 1, 2, 3" />
              </div>
              <div className="form-group">
                <label>Action</label>
                <select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
                  <option value="Approved">Approve</option>
                  <option value="Rejected">Reject</option>
                  <option value="Pending">Set Pending</option>
                </select>
              </div>
              <div className="form-group">
                <label>Approved By</label>
                <input value={bulkApprovedBy} onChange={(e) => setBulkApprovedBy(e.target.value)} placeholder="Name" />
              </div>
            </div>
            <button className="btn btn-primary" onClick={handleBulkSubmit}>
              Apply Bulk Action
            </button>
          </div>
        )}

        <div className="table-wrap review-table-compact">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Requester</th>
                <th>Budget</th>
                <th>Building Type</th>
                <th>Status</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr className="table-empty-row">
                  <td colSpan={isAdmin ? 8 : 7}>No requests match the current filter</td>
                </tr>
              ) : requests.map((req) => (
                <tr key={req.id}>
                  <td>{req.id}</td>
                  <td>{req.item_name || req.item_id}</td>
                  <td>{req.qty}</td>
                  <td>{req.requested_by}</td>
                  <td>{req.budget}</td>
                  <td>{req.building_subtype || '-'}</td>
                  <td>{getStatusBadge(req.status)}</td>
                  {isAdmin && (
                    <td>
                      <div className="table-actions">
                        {req.status === 'Pending' && (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => handleApprove(req)}>Approve</button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleReject(req)}>Reject</button>
                          </>
                        )}
                        {(req.status === 'Approved' || req.status === 'Rejected') && (
                          <button className="btn btn-danger btn-sm" onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(req.id); }}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      <div className="card">
        {!isAdmin && (
          <div className="review-header review-header-spaced">
            <div>
              <h2>Review & History</h2>
              <p className="caption">Pending, approved, and rejected requests</p>
            </div>
          </div>
        )}
        <div className="history-tabs">
          {!isAdmin && (
            <button
              className={historyTab === 'pending' ? 'active' : ''}
              onClick={() => setHistoryTab('pending')}
            >
              Pending
            </button>
          )}
          <button
            className={historyTab === 'approved' ? 'active' : ''}
            onClick={() => setHistoryTab('approved')}
          >
            Approved
          </button>
          <button
            className={historyTab === 'rejected' ? 'active' : ''}
            onClick={() => setHistoryTab('rejected')}
          >
            Rejected
          </button>
          {isAdmin && (
            <button
              className={historyTab === 'deleted' ? 'active' : ''}
              onClick={() => setHistoryTab('deleted')}
            >
              Deleted
            </button>
          )}
        </div>

        {activeHistoryTab === 'pending' && !isAdmin && (
          <div className="table-wrap review-table-compact">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Requester</th>
                  <th>Budget</th>
                  <th>Building Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pending.length === 0 ? (
                  <tr className="table-empty-row">
                    <td colSpan={7}>No pending requests</td>
                  </tr>
                ) : pending.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.item_name || r.item_id}</td>
                    <td>{r.qty}</td>
                    <td>{r.requested_by}</td>
                    <td>{r.budget || '-'}</td>
                    <td>{r.building_subtype || '-'}</td>
                    <td>{getStatusBadge(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeHistoryTab === 'approved' && (
          <div className="table-wrap review-table-compact">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Requester</th>
                  <th>Budget</th>
                  <th>Building Type</th>
                  <th>Status</th>
                  <th>Approved By</th>
                </tr>
              </thead>
              <tbody>
                {approved.length === 0 ? (
                  <tr className="table-empty-row">
                    <td colSpan={8}>No approved requests</td>
                  </tr>
                ) : approved.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.item_name || r.item_id}</td>
                    <td>{r.qty}</td>
                    <td>{r.requested_by}</td>
                    <td>{r.budget || '-'}</td>
                    <td>{r.building_subtype || '-'}</td>
                    <td>{getStatusBadge(r.status)}</td>
                    <td>{r.approved_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeHistoryTab === 'rejected' && (
          <div className="table-wrap review-table-compact">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Requester</th>
                  <th>Budget</th>
                  <th>Building Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rejected.length === 0 ? (
                  <tr className="table-empty-row">
                    <td colSpan={7}>No rejected requests</td>
                  </tr>
                ) : rejected.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.item_name || r.item_id}</td>
                    <td>{r.qty}</td>
                    <td>{r.requested_by}</td>
                    <td>{r.budget || '-'}</td>
                    <td>{r.building_subtype || '-'}</td>
                    <td>{getStatusBadge(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeHistoryTab === 'deleted' && isAdmin && (
          <>
            <div className="table-wrap review-table-compact">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Req ID</th>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Requester</th>
                    <th>Budget</th>
                    <th>Building Type</th>
                    <th>Status</th>
                    <th>Deleted At</th>
                    <th>Deleted By</th>
                  </tr>
                </thead>
                <tbody>
                  {deleted.length === 0 ? (
                    <tr className="table-empty-row">
                      <td colSpan={9}>No deleted requests</td>
                    </tr>
                  ) : deleted.map((d) => (
                    <tr key={d.id}>
                      <td>{d.req_id}</td>
                      <td>{d.item_name}</td>
                      <td>{d.qty}</td>
                      <td>{d.requested_by}</td>
                      <td>{d.budget || '-'}</td>
                      <td>{d.building_subtype || '-'}</td>
                      <td>{getStatusBadge(d.status)}</td>
                      <td>{d.deleted_at ? formatDate(d.deleted_at) : '-'}</td>
                      <td>{d.deleted_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-danger btn-cleardeleted" onClick={() => clearDeletedMutation.mutate()}>
              Clear All Deleted Logs
            </button>
          </>
        )}
      </div>
    </div>
  );
}
