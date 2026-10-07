import { formatDate, formatNaira } from '../api';
import { requestCostSummary } from '../utils/requests';
import './RequestDetails.css';

export default function RequestDetails({ request, showProject = false }) {
  const cost = requestCostSummary(request);
  return <div className="request-item-details">
    <strong>{request.item_name || `Item #${request.item_id}`}</strong>
    {showProject && request.project_site && <small>{request.project_site}</small>}
    {request.item_budget_scope && <small>{request.item_budget_scope}</small>}
    {cost.totalCost != null && <small className="request-cost">{cost.recorded ? 'Recorded' : 'Estimated'} cost: {formatNaira(cost.totalCost)}</small>}
    <details>
      <summary aria-label={`Details for request ${request.id}`}>Details</summary>
      <dl>
        <dt>{cost.recorded ? 'Approved' : cost.hasOverride ? 'Requested' : 'Current'} unit price</dt>
        <dd>{cost.unitCost == null ? 'Not available' : `${formatNaira(cost.unitCost)}${request.item_unit ? ` / ${request.item_unit}` : ''}`}</dd>
        {request.item_section && <><dt>Section</dt><dd>{request.item_section}</dd></>}
        {request.created_at && <><dt>Submitted</dt><dd>{formatDate(request.created_at)}</dd></>}
        {request.status !== 'Pending' && request.updated_at && <><dt>Decision</dt><dd>{formatDate(request.updated_at)}{request.approved_by ? ` · ${request.approved_by}` : ''}</dd></>}
      </dl>
      {request.note && <p><strong>Note</strong><span>{request.note}</span></p>}
    </details>
  </div>;
}
