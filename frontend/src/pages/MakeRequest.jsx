import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];
const BUILDING_SUBTYPE_OPTIONS = {
  Flats: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13'],
  Terraces: ['A (T1-T6)', 'B (T7-T12)', 'C (T13-T18)', 'D (T19-T24)', 'E (T25-T30)', 'F (T31-T36)', 'G (T37-T42)', 'H (T43-T48)', 'I (T49-T53)', 'J (T54-T58)', 'K (T59-T64)', 'L (T65-T70)', 'M (T71-T76)', 'N (T77-T82)', 'O (T83-T88)', 'P (T89-T94)', 'Q (T95-T100)', 'R (T101-T106)', 'S (T107-T112)', 'T (T113-T118)', 'U (T119-T124)', 'V (T125-T130)', 'W (T131-T136)', 'X (T137-T142)'],
  'Semi-detached': Array.from({ length: 29 }, (_, i) => `SD ${i + 1}`),
  'Fully-detached': Array.from({ length: 52 }, (_, i) => `D${i + 1}`),
};

export default function MakeRequest() {
  const { user, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [budgetNum, setBudgetNum] = useState('');
  const [buildingType, setBuildingType] = useState('');
  const [budgetLabel, setBudgetLabel] = useState('');
  const [buildingSubtype, setBuildingSubtype] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(1);
  const [currentPrice, setCurrentPrice] = useState('');
  const [note, setNote] = useState('');

  const params = {};
  const ps = getEffectiveProjectSite();
  if (ps) params.project_site = ps;
  if (buildingType) params.building_type = buildingType;

  const { data: items = [] } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
  });

  let filteredItems = items;
  if (budgetNum) filteredItems = filteredItems.filter((i) => (i.budget || '').includes(budgetNum));
  if (budgetLabel) filteredItems = filteredItems.filter((i) => i.budget === budgetLabel);

  const needsSubtype = buildingType && BUILDING_SUBTYPE_OPTIONS[buildingType];
  const subtypeOptions = needsSubtype ? BUILDING_SUBTYPE_OPTIONS[buildingType] : [];

  const createMutation = useMutation({
    mutationFn: (data) => api.requests.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries(['requests']);
      queryClient.invalidateQueries(['notifications']);
      setItemId('');
      setQty(1);
      setCurrentPrice('');
      setNote('');
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!itemId || !budgetLabel) return;
    if (needsSubtype && !buildingSubtype) {
      alert('Please select ' + buildingType + ' subtype');
      return;
    }
    createMutation.mutate({
      item_id: parseInt(itemId),
      qty: Number(qty),
      requested_by: user?.full_name || user?.username || 'Unknown',
      current_price: currentPrice ? parseFloat(currentPrice) : null,
      note: note || null,
      building_subtype: buildingSubtype || null,
      project_site: getEffectiveProjectSite(),
    });
  };

  const budgetLabels = [...new Set(
    items
      .filter((i) => !budgetNum || (i.budget || '').includes(budgetNum))
      .map((i) => i.budget)
      .filter(Boolean)
  )].sort();

  const formatQty = (value) => {
    const num = Number(value);
    if (Number.isNaN(num)) return value;
    return num.toLocaleString('en-NG', { maximumFractionDigits: 2 });
  };

  const selectedItem = items.find((i) => String(i.id) === String(itemId));
  const itemUnitCost = Number(selectedItem?.unit_cost || 0);
  const overrideUnitCost = currentPrice === '' ? null : Number(currentPrice);
  const effectiveUnitCost = overrideUnitCost != null && !Number.isNaN(overrideUnitCost)
    ? overrideUnitCost
    : itemUnitCost;
  const totalCost = Number(qty || 0) * Number(effectiveUnitCost || 0);
  const showTotal = Boolean(itemId) && Number(qty) > 0;

  return (
    <div className="card">
      <h2>Make a Request</h2>

      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <div className="form-group">
            <label>Budget Number</label>
            <select
              value={budgetNum}
              onChange={(e) => {
                setBudgetNum(e.target.value);
                setBudgetLabel('');
              }}
            >
              <option value="">All</option>
              {Array.from({ length: 20 }, (_, i) => (
                <option key={i} value={`Budget ${i + 1}`}>Budget {i + 1}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Building Type</label>
            <select
              value={buildingType}
              onChange={(e) => {
                setBuildingType(e.target.value);
                setBudgetLabel('');
                setBuildingSubtype('');
              }}
            >
              <option value="">All</option>
              {PROPERTY_TYPES.filter((t) => t && t !== 'All').map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Budget</label>
            <select value={budgetLabel} onChange={(e) => setBudgetLabel(e.target.value)}>
              <option value="">Select budget</option>
              {budgetLabels.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          {needsSubtype && (
            <div className="form-group">
              <label>Building Subtype</label>
              <select value={buildingSubtype} onChange={(e) => setBuildingSubtype(e.target.value)} required>
                <option value="">Select...</option>
                {subtypeOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="form-row">
          <div className="form-group form-group-wide">
            <label>Item</label>
            <select value={itemId} onChange={(e) => setItemId(e.target.value)} required>
              <option value="">Select item</option>
              {filteredItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.unit}) - {formatQty(i.qty)} available - {formatNaira(i.unit_cost)} / {i.unit}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Quantity</label>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(parseFloat(e.target.value) || 1)}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Requested By</label>
            <input
              value={user?.full_name || user?.username || ''}
              readOnly
              disabled
            />
          </div>
          <div className="form-group">
            <label>Current Price Override (₦)</label>
            <input
              type="number"
              step={0.01}
              value={currentPrice}
              onChange={(e) => setCurrentPrice(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        {showTotal && (
          <div className="form-row">
            <div className="form-group">
              <label>Estimated Total (₦)</label>
              <input
                value={formatNaira(totalCost)}
                readOnly
                disabled
              />
            </div>
            <div className="form-group">
              <label>Price Source</label>
              <input
                value={overrideUnitCost != null && !Number.isNaN(overrideUnitCost)
                  ? `Override price (${formatNaira(overrideUnitCost)} per unit)`
                  : `Item unit cost (${formatNaira(itemUnitCost)} per unit)`}
                readOnly
                disabled
              />
            </div>
          </div>
        )}

        <div className="form-group">
          <label>Note</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </div>

        <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Submitting...' : 'Submit Request'}
        </button>
      </form>
    </div>
  );
}
