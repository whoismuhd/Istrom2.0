import { formatQuantity, requestAvailability } from '../utils/inventory.js';
import EmptyState from '../components/EmptyState';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatDate } from '../api';

export default function ReviewHistory() {
  const { isAdmin, isGlobalAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState('Pending');
  const [historyTab, setHistoryTab] = useState(isAdmin ? 'approved' : 'pending'); // pending | approved | rejected | deleted (deleted only for admin)
  const activeHistoryTab = isAdmin && historyTab === 'pending' ? 'approved' : historyTab;
  const [bulkIds, setBulkIds] = useState('');
  const [bulkAction, setBulkAction] = useState('Approved');
  const [bulkError, setBulkError] = useState('');
  const [bulkPending, setBulkPending] = useState(false);

  const params = { project_site: getEffectiveProjectSite() };

  const { data: requests = [], error: requestsError, isLoading: requestsLoading, refetch: retryRequests } = useQuery({
    queryKey: ['requests', params],
    queryFn: () => api.requests.list(params),
  });

  const { data: deleted = [], error: deletedError, isLoading: deletedLoading, refetch: retryDeleted } = useQuery({
    queryKey: ['deletedRequests', params],
    queryFn: () => api.deletedRequests.list(params),
    enabled: isAdmin,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.requests.updateStatus(id, data),
    onError: () => {
      for (const key of ['requests', 'items', 'actuals', 'dashboard']) queryClient.invalidateQueries({ queryKey: [key] });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['actuals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.requests.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['deletedRequests'] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['actuals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const clearDeletedMutation = useMutation({
    mutationFn: () => api.deletedRequests.clear(params),
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

  const handleBulkSubmit = async () => {
    setBulkError('');
    updateMutation.reset();
    const ids = [...new Set(bulkIds.split(/[\s,]+/).filter(Boolean).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      setBulkError('Enter valid request IDs separated by commas or spaces.');
      return;
    }
    setBulkPending(true);
    const failed = [];
    for (const id of ids) {
      try {
        await updateMutation.mutateAsync({ id, data: { status: bulkAction, approved_by: 'Admin' } });
      } catch (error) {
        failed.push({ id, message: error.message });
      }
    }
    setBulkIds(failed.map((failure) => failure.id).join(', '));
    setBulkError(failed.map((failure) => `Request ${failure.id}: ${failure.message}`).join('; '));
    setBulkPending(false);
  };

  const loadError = requestsError || deletedError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryRequests(); retryDeleted(); }} />;
  if (requestsLoading || deletedLoading) return <div className="card" role="status">Loading...</div>;

  const filteredRequests = isAdmin && statusFilter ? requests.filter((r) => r.status === statusFilter) : requests;
  const pending = requests.filter((r) => r.status === 'Pending');
  const approved = requests.filter((r) => r.status === 'Approved');
  const rejected = requests.filter((r) => r.status === 'Rejected');

  const getStatusBadge = (s) => {
    const c = s === 'Pending' ? 'badge-pending' : s === 'Approved' ? 'badge-approved' : 'badge-rejected';
    return <span className={`badge ${c}`}>{s}</span>;
  };

  return (
    <div className="review-history-page">
      <ErrorMessage error={bulkError || updateMutation.error || deleteMutation.error || clearDeletedMutation.error} />
      {isAdmin && (
      <div className="card">
        <div className="review-header">
          <div>
            <h1>Request approvals</h1>
            <p className="caption">Review requests and their approval history.</p>
          </div>
          <div className="form-group form-group-compact">
            <label htmlFor="reviewhistory-field-1">Status</label>
            <select id="reviewhistory-field-1" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              <option value="Pending">Pending</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
            </select>
          </div>
        </div>

        {requests.length > 0 && (
          <details className="bulk-actions">
            <summary>Update multiple requests</summary>
            <div className="bulk-actions-body">
            <div className="form-row">
              <div className="form-group form-group-wide">
                <label htmlFor="reviewhistory-field-2">Request IDs (comma-separated)</label>
                <input id="reviewhistory-field-2" value={bulkIds} onChange={(e) => setBulkIds(e.target.value)} placeholder="e.g. 1, 2, 3" />
              </div>
              <div className="form-group">
                <label htmlFor="reviewhistory-field-3">Action</label>
                <select id="reviewhistory-field-3" value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
                  <option value="Approved">Approve</option>
                  <option value="Rejected">Reject</option>
                  <option value="Pending">Set Pending</option>
                </select>
              </div>

            </div>
            {bulkAction === 'Approved' && <p className="caption">Approvals record the full requested quantity, including any excess above availability.</p>}
            <button className="btn btn-primary" onClick={handleBulkSubmit} disabled={bulkPending || updateMutation.isPending}>
              {bulkPending ? 'Applying...' : 'Apply action'}
            </button>
            </div>
          </details>
        )}

        <div className="table-wrap review-table-compact">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Item</th>
                <th>Quantity / availability</th>
                <th>Requester</th>
                <th>Budget</th>
                <th>Building Type</th>
                <th>Status</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filteredRequests.length === 0 ? (
                <tr className="table-empty-row">
                  <td colSpan={isAdmin ? 8 : 7}><EmptyState title="No requests match the current filter" description="Requests will appear here when they match this view." /></td>
                </tr>
              ) : filteredRequests.map((req) => {
                const availability = requestAvailability(req.qty, req.available_qty);
                const blocked = req.status === 'Pending' && !availability.known;
                const overQuantity = req.status === 'Pending' && availability.insufficient;
                const approvedOverQuantity = req.status === 'Approved' && req.approved_shortage_qty > 0;
                return (
                <tr key={req.id} className={blocked || overQuantity || approvedOverQuantity ? 'request-shortage-row' : ''}>
                  <td>{req.id}</td>
                  <td>{req.item_name || req.item_id}{req.item_budget_scope && <small className="scope-caption">{req.item_budget_scope}</small>}</td>
                  <td className="request-availability-cell">
                    <strong>{formatQuantity(req.qty)} {req.item_unit}</strong>
                    {req.status === 'Pending' && <small>Available: {availability.known ? `${formatQuantity(req.available_qty)} ${req.item_unit || ''}` : 'Item unavailable'}</small>}
                    {blocked && <span className="shortage-label">Linked item unavailable</span>}
                    {overQuantity && <span className="shortage-label">Shortfall: {formatQuantity(availability.shortage)} {req.item_unit}</span>}
                    {approvedOverQuantity && <span className="shortage-label">Approved over quantity: {formatQuantity(req.approved_shortage_qty)} {req.item_unit}</span>}
                  </td>
                  <td>{req.requested_by}</td>
                  <td>{req.budget}</td>
                  <td>{req.building_subtype || '-'}</td>
                  <td>{getStatusBadge(req.status)}</td>
                  {isAdmin && (
                    <td>
                      <div className="table-actions">
                        {req.status === 'Pending' && (
                          <>
                            <button className={`btn ${overQuantity ? 'btn-shortage' : 'btn-primary'} btn-sm`} disabled={blocked || bulkPending || updateMutation.isPending} title={blocked ? 'Linked inventory item is unavailable' : overQuantity ? 'Approve the full quantity and record the excess in Actuals' : 'Approve request'} onClick={() => handleApprove(req)}>{overQuantity ? 'Approve over quantity' : 'Approve'}</button>
                            <button className="btn btn-danger btn-sm" disabled={bulkPending || updateMutation.isPending} onClick={() => handleReject(req)}>Reject</button>
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
              ); })}
            </tbody>
          </table>
        </div>
      </div>
      )}

      <div className="card">
        {!isAdmin && (
          <div className="review-header review-header-spaced">
            <div>
              <h1>Site requests</h1>
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
                    <td colSpan={7}><EmptyState title="No pending requests" description="Requests will appear here when they match this view." /></td>
                  </tr>
                ) : pending.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.item_name || r.item_id}{r.item_budget_scope && <small className="scope-caption">{r.item_budget_scope}</small>}</td>
                    <td className="request-availability-cell">{formatQuantity(r.qty)} {r.item_unit}
                      {r.shortage_qty > 0 && <span className="shortage-label">Shortfall: {formatQuantity(r.shortage_qty)} {r.item_unit}</span>}
                    </td>
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
                    <td colSpan={8}><EmptyState title="No approved requests" description="Requests will appear here when they match this view." /></td>
                  </tr>
                ) : approved.map((r) => (
                  <tr key={r.id} className={r.approved_shortage_qty > 0 ? 'request-shortage-row' : ''}>
                    <td>{r.id}</td>
                    <td>{r.item_name || r.item_id}{r.item_budget_scope && <small className="scope-caption">{r.item_budget_scope}</small>}</td>
                    <td className="request-availability-cell">{formatQuantity(r.qty)} {r.item_unit}
                      {r.approved_shortage_qty > 0 && <span className="shortage-label">Approved over quantity: {formatQuantity(r.approved_shortage_qty)} {r.item_unit}</span>}
                    </td>
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
                    <td colSpan={7}><EmptyState title="No rejected requests" description="Requests will appear here when they match this view." /></td>
                  </tr>
                ) : rejected.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.item_name || r.item_id}{r.item_budget_scope && <small className="scope-caption">{r.item_budget_scope}</small>}</td>
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
                      <td colSpan={9}><EmptyState title="No deleted requests" description="Requests will appear here when they match this view." /></td>
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
            {isGlobalAdmin && <button className="btn btn-danger btn-cleardeleted" disabled={!deleted.length || clearDeletedMutation.isPending} onClick={() => {
              if (confirm(`Permanently clear deleted-request logs for ${params.project_site || 'all project sites'}?`)) clearDeletedMutation.mutate();
            }}>
              {clearDeletedMutation.isPending ? 'Clearing…' : 'Clear displayed deleted logs'}
            </button>}
          </>
        )}
      </div>
    </div>
  );
}
