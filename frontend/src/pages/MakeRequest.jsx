import AvailabilityNotice from '../components/AvailabilityNotice';
import { requestAvailability } from '../utils/inventory.js';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { budgetNumberOptions } from '../utils/budgets';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import { decimalProduct } from '../utils/numbers';
import { usePersistentState } from '../hooks/usePersistentState';
import { draftChanged, editFormDraft, formSubmissionKey, REQUEST_DRAFT, requestDraftSelection } from '../utils/formDrafts';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function MakeRequest() {
  const { user, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [draft, setDraft, clearDraft, storageError] = usePersistentState('request-draft', REQUEST_DRAFT);
  const { budgetNum, buildingType, budgetLabel, buildingSubtype, itemId, qty, currentPrice, note } = draft;
  const updateDraft = (changes) => setDraft((previous) => editFormDraft(previous, changes));
  const [formError, setFormError] = useState('');

  const params = {};
  const ps = getEffectiveProjectSite();
  if (ps) params.project_site = ps;
  if (buildingType) params.building_type = buildingType;

  const { data: items = [], error: itemsError, isLoading: itemsLoading, refetch: retryItems } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
  });

  const { filteredItems, selectedItem, selectedBuildingType, subtypeOptions, budgetLabels, staleBudget, staleItem, staleSubtype } = requestDraftSelection(draft, items);
  const needsSubtype = subtypeOptions.length > 0;

  const createMutation = useMutation({
    mutationFn: ({ data }) => api.requests.create(data),
    onSuccess: (_request, variables) => {
      queryClient.invalidateQueries({ queryKey: ['requests'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setFormError('');
      variables.clearDraft();
    },
  });
  const currentMutation = !createMutation.variables || createMutation.variables.data.project_site === ps;

  const loadError = itemsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryItems(); }} />;
  if (itemsLoading) return <div className="card" role="status">Loading...</div>;

  const handleSubmit = (e) => {
    e.preventDefault();
    setFormError('');
    createMutation.reset();
    if (!itemId || !budgetLabel || staleBudget || !selectedItem) {
      setFormError('Select a budget and an item that matches the current filters.');
      return;
    }
    if (staleSubtype || (needsSubtype && !subtypeOptions.includes(buildingSubtype))) {
      setFormError('Select a building subtype for ' + selectedBuildingType + '.');
      return;
    }
    if (!availability.valid) {
      setFormError('Enter a quantity greater than zero.');
      return;
    }
    if (currentPrice !== '' && (!Number.isFinite(Number(currentPrice)) || Number(currentPrice) < 0)) {
      setFormError('Enter a valid unit price of zero or more.');
      return;
    }
    const submissionKey = formSubmissionKey(draft);
    const submittedDraft = { ...draft, submissionKey };
    if (setDraft(submittedDraft)) {
      setFormError('This browser could not save your draft. Try again before submitting.');
      return;
    }
    createMutation.mutate({
      clearDraft: () => clearDraft(submittedDraft),
      data: {
        submission_key: submissionKey,
        item_id: parseInt(itemId),
        expected_item_created_at: draft.itemCreatedAt || null,
        qty: Number(qty),
        requested_by: user?.username || 'Unknown',
        current_price: currentPrice ? parseFloat(currentPrice) : null,
        note: note || null,
        building_subtype: buildingSubtype || null,
        project_site: getEffectiveProjectSite(),
      },
    });
  };

  const availability = requestAvailability(qty, selectedItem?.qty);
  const itemUnitCost = Number(selectedItem?.unit_cost || 0);
  const overrideUnitCost = currentPrice === '' ? null : Number(currentPrice);
  const effectiveUnitCost = overrideUnitCost != null && !Number.isNaN(overrideUnitCost)
    ? overrideUnitCost
    : itemUnitCost;
  const totalCost = decimalProduct(Number(qty || 0), Number(effectiveUnitCost || 0));
  const showTotal = Boolean(selectedItem) && Number(qty) > 0;

  return (
    <div className="card request-card">
      <h1>New request</h1>
      {storageError && <div className="alert alert-warning" role="status">Draft could not be saved. Keep this tab open until you submit.</div>}
      {(staleBudget || staleItem || staleSubtype) && <div className="alert alert-warning" role="status">A saved selection is no longer available. Select the budget, item and building again.</div>}
      <ErrorMessage error={(currentMutation && createMutation.error) || formError} />
      {currentMutation && createMutation.isSuccess && <div className="request-confirmation" role="status"><strong>Request #{createMutation.data.id} submitted</strong><span>{createMutation.data.status === 'Pending' ? 'Pending approval' : createMutation.data.status}</span></div>}

      <form onSubmit={handleSubmit}>
        <fieldset className="form-fields" disabled={createMutation.isPending}>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="makerequest-field-1">Budget number</label>
            <select id="makerequest-field-1"
              value={budgetNum}
              onChange={(e) => {
                updateDraft({ budgetNum: e.target.value, budgetLabel: '', itemId: '', itemCreatedAt: '', currentPrice: '', buildingSubtype: '' });
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
                updateDraft({ buildingType: e.target.value, budgetLabel: '', itemId: '', itemCreatedAt: '', currentPrice: '', buildingSubtype: '' });
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
            <select id="makerequest-field-3" value={budgetLabel} onChange={(e) => updateDraft({ budgetLabel: e.target.value, itemId: '', itemCreatedAt: '', currentPrice: '', buildingSubtype: '' })}>
              <option value="">Select budget</option>
              {staleBudget && <option value={budgetLabel} disabled>{budgetLabel} — unavailable</option>}
              {budgetLabels.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          {needsSubtype && (
            <div className="form-group">
              <label htmlFor="makerequest-field-4">Building subtype</label>
              <select id="makerequest-field-4" value={buildingSubtype} onChange={(e) => updateDraft({ buildingSubtype: e.target.value })} required>
                <option value="">Select...</option>
                {staleSubtype && <option value={buildingSubtype} disabled>{buildingSubtype} — unavailable</option>}
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
            <select id="makerequest-field-5" value={staleItem ? `unavailable:${itemId}` : itemId} onChange={(e) => updateDraft({ itemId: e.target.value, itemCreatedAt: String(items.find((item) => String(item.id) === e.target.value)?.created_at || ''), currentPrice: '', buildingSubtype: '' })} required>
              <option value="">Select item</option>
              {staleItem && <option value={`unavailable:${itemId}`} disabled>Item unavailable — select another item</option>}
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
              onChange={(e) => updateDraft({ qty: e.target.value })}
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
              onChange={(e) => updateDraft({ currentPrice: e.target.value })}
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
          <textarea id="makerequest-field-11" value={note} onChange={(e) => updateDraft({ note: e.target.value })} rows={2} />
        </div>

        <button type="submit" className={`btn ${availability.insufficient ? 'btn-shortage' : 'btn-primary'}`} disabled={createMutation.isPending || !availability.valid}>
          {createMutation.isPending ? 'Submitting...' : availability.insufficient ? 'Submit request with shortage' : 'Submit request'}
        </button>
        {draftChanged(draft, REQUEST_DRAFT) && <button type="button" className="btn" disabled={createMutation.isPending} onClick={() => { clearDraft(); setFormError(''); createMutation.reset(); }}>Discard draft</button>}
        </fieldset>
      </form>
    </div>
  );
}
