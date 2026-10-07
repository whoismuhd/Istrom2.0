import AvailabilityNotice from '../components/AvailabilityNotice';
import { requestAvailability } from '../utils/inventory.js';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { matchesBudget, budgetNumberOptions } from '../utils/budgets';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import { BUILDING_SUBTYPE_OPTIONS, requestBuildingType } from '../utils/buildings';
import { decimalProduct } from '../utils/numbers';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

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
  const [formError, setFormError] = useState('');
  const clearSelectedItem = () => { setItemId(''); setCurrentPrice(''); setBuildingSubtype(''); };

  const params = {};
  const ps = getEffectiveProjectSite();
  if (ps) params.project_site = ps;
  if (buildingType) params.building_type = buildingType;

  const { data: items = [], error: itemsError, isLoading: itemsLoading, refetch: retryItems } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
  });

  let filteredItems = items;
  if (budgetNum) filteredItems = filteredItems.filter((i) => matchesBudget(i.budget, budgetNum));
  if (budgetLabel) filteredItems = filteredItems.filter((i) => i.budget === budgetLabel);

  const selectedItem = items.find((i) => String(i.id) === String(itemId));
  const selectedBuildingType = requestBuildingType(selectedItem, buildingType);
  const subtypeOptions = BUILDING_SUBTYPE_OPTIONS[selectedBuildingType] || [];
  const needsSubtype = subtypeOptions.length > 0;

  const createMutation = useMutation({
    mutationFn: (data) => api.requests.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setFormError('');
      setItemId('');
      setQty(1);
      setCurrentPrice('');
      setNote('');
    },
  });

  const loadError = itemsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryItems(); }} />;
  if (itemsLoading) return <div className="card" role="status">Loading...</div>;

  const handleSubmit = (e) => {
    e.preventDefault();
    setFormError('');
    createMutation.reset();
    if (!itemId || !budgetLabel || !filteredItems.some((item) => String(item.id) === itemId)) {
      setFormError('Select a budget and an item that matches the current filters.');
      return;
    }
    if (needsSubtype && !subtypeOptions.includes(buildingSubtype)) {
      setFormError('Select a building subtype for ' + selectedBuildingType + '.');
      return;
    }
    if (!availability.valid) {
      setFormError('Enter a quantity greater than zero.');
      return;
    }
    createMutation.mutate({
      item_id: parseInt(itemId),
      qty: Number(qty),
      requested_by: user?.username || 'Unknown',
      current_price: currentPrice ? parseFloat(currentPrice) : null,
      note: note || null,
      building_subtype: buildingSubtype || null,
      project_site: getEffectiveProjectSite(),
    });
  };

  const budgetLabels = [...new Set(
    items
      .filter((i) => !budgetNum || matchesBudget(i.budget, budgetNum))
      .map((i) => i.budget)
      .filter(Boolean)
  )].sort();

  const availability = requestAvailability(qty, selectedItem?.qty);
  const itemUnitCost = Number(selectedItem?.unit_cost || 0);
  const overrideUnitCost = currentPrice === '' ? null : Number(currentPrice);
  const effectiveUnitCost = overrideUnitCost != null && !Number.isNaN(overrideUnitCost)
    ? overrideUnitCost
    : itemUnitCost;
  const totalCost = decimalProduct(Number(qty || 0), Number(effectiveUnitCost || 0));
  const showTotal = Boolean(itemId) && Number(qty) > 0;

  return (
    <div className="card request-card">
      <h1>New request</h1>
      <ErrorMessage error={createMutation.error || formError} />
      {createMutation.isSuccess && <div className="request-confirmation" role="status"><strong>Request #{createMutation.data.id} submitted</strong><span>Pending approval</span></div>}

      <form onSubmit={handleSubmit}>
        <fieldset className="form-fields" disabled={createMutation.isPending}>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="makerequest-field-1">Budget number</label>
            <select id="makerequest-field-1"
              value={budgetNum}
              onChange={(e) => {
                setBudgetNum(e.target.value);
                setBudgetLabel('');
                clearSelectedItem();
              }}
            >
              <option value="">All</option>
              {budgetNumberOptions(items).map((budget) => (
                <option key={budget} value={budget}>{budget}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="makerequest-field-2">Building type</label>
            <select id="makerequest-field-2"
              value={buildingType}
              onChange={(e) => {
                setBuildingType(e.target.value);
                setBudgetLabel('');
                setBuildingSubtype('');
                clearSelectedItem();
              }}
            >
              <option value="">All</option>
              {PROPERTY_TYPES.filter((t) => t && t !== 'All').map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="makerequest-field-3">Budget</label>
            <select id="makerequest-field-3" value={budgetLabel} onChange={(e) => { setBudgetLabel(e.target.value); clearSelectedItem(); }}>
              <option value="">Select budget</option>
              {budgetLabels.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          {needsSubtype && (
            <div className="form-group">
              <label htmlFor="makerequest-field-4">Building subtype</label>
              <select id="makerequest-field-4" value={buildingSubtype} onChange={(e) => setBuildingSubtype(e.target.value)} required>
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
            <label htmlFor="makerequest-field-5">Item</label>
            <select id="makerequest-field-5" value={itemId} onChange={(e) => { setItemId(e.target.value); setCurrentPrice(''); setBuildingSubtype(''); }} required>
              <option value="">Select item</option>
              {filteredItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.unit}){i.budget_scope ? ` · ${i.budget_scope}` : ''} — {formatNaira(i.unit_cost)} per {i.unit}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="makerequest-field-6">Quantity{selectedItem ? ` (${selectedItem.unit})` : ''}</label>
            <input id="makerequest-field-6"
              type="number"
              min={0}
              step="any"
              required
              className={availability.insufficient ? 'input-shortage' : ''}
              aria-invalid={availability.insufficient || !availability.valid}
              aria-describedby={selectedItem ? 'request-availability' : undefined}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
        </div>

        {selectedItem && <div id="request-availability"><AvailabilityNotice quantity={qty} available={selectedItem.qty} unit={selectedItem.unit} /></div>}

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="makerequest-field-8">Unit price (₦)</label>
            <input id="makerequest-field-8"
              type="number"
              step={0.01}
              min={0}
              value={currentPrice}
              onChange={(e) => setCurrentPrice(e.target.value)}
              placeholder="Optional"
            />
          </div>
          {showTotal && (
            <div className="form-group">
              <label htmlFor="makerequest-field-9">Estimated total (₦)</label>
              <input id="makerequest-field-9"
                value={formatNaira(totalCost)}
                readOnly
                disabled
              />
            </div>
          )}
        </div>

        <div className="form-group">
          <label htmlFor="makerequest-field-11">Note</label>
          <textarea id="makerequest-field-11" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </div>

        <button type="submit" className={`btn ${availability.insufficient ? 'btn-shortage' : 'btn-primary'}`} disabled={createMutation.isPending || !availability.valid}>
          {createMutation.isPending ? 'Submitting...' : availability.insufficient ? 'Submit request with shortage' : 'Submit request'}
        </button>
        </fieldset>
      </form>
    </div>
  );
}
