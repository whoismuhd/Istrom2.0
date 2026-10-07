import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api } from '../api';
import { formatNaira } from '../api';
import { decimalProduct } from '../utils/numbers';
import { usePersistentState } from '../hooks/usePersistentState';
import { draftChanged, editFormDraft, formSubmissionKey, MANUAL_ENTRY_DRAFT, manualDraftSelection } from '../utils/formDrafts';

const PROPERTY_TYPES = ['', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function ManualEntry() {
  const { isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [draft, setDraft, clearDraft, storageError] = usePersistentState('manual-entry-draft', MANUAL_ENTRY_DRAFT);
  const { buildingType, budgetNum, section, budgetLabel, name, qty, unit, unitCost, category } = draft;
  const updateDraft = (changes) => setDraft((previous) => editFormDraft(previous, changes));
  const [formError, setFormError] = useState('');

  const { data: constants = {}, error: constantsError, isLoading: constantsLoading, refetch: retryConstants } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });

  const { sections, categories, budgetLabels, staleSection, staleCategory, staleBudget } = manualDraftSelection(draft, constants);

  const createMutation = useMutation({
    mutationFn: ({ data }) => api.items.create(data),
    onSuccess: (_item, variables) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setFormError('');
      variables.clearDraft();
    },
  });
  const currentMutation = !createMutation.variables || createMutation.variables.data.project_site === getEffectiveProjectSite();

  const loadError = constantsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryConstants(); }} />;
  if (constantsLoading) return <div className="card" role="status">Loading...</div>;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!getEffectiveProjectSite()) {
      setFormError('Select a project site in the header before adding an item.');
      return;
    }
    setFormError('');
    createMutation.reset();
    if (!isAdmin) return;
    if (!name.trim() || !buildingType || !budgetNum || !section || staleSection || staleCategory || !budgetLabels.includes(budgetLabel)) {
      setFormError('Enter an item name and select a building type, budget number, section, and budget label.');
      return;
    }

    const qtyNum = Number(qty);
    const unitCostNum = Number(unitCost);
    if (qty === '' || unitCost === '' || !Number.isFinite(qtyNum) || !Number.isFinite(unitCostNum) || qtyNum < 0 || unitCostNum < 0 || !unit.trim()) {
      setFormError('Enter a unit and valid quantities and costs of zero or more.');
      return;
    }
    const submissionKey = formSubmissionKey(draft);
    const submittedDraft = { ...draft, submissionKey };
    if (setDraft(submittedDraft)) {
      setFormError('This browser could not save your draft. Try again before adding the item.');
      return;
    }
    createMutation.mutate({
      clearDraft: () => clearDraft(submittedDraft),
      data: {
        submission_key: submissionKey,
        name: name.trim(),
        qty: qtyNum,
        unit: unit.trim(),
        unit_cost: unitCostNum,
        category,
        budget: budgetLabel,
        section,
        building_type: buildingType,
        project_site: getEffectiveProjectSite(),
      },
    });
  };

  const qtyNum = qty === '' ? 0 : parseFloat(qty) || 0;
  const unitCostNum = unitCost === '' ? 0 : parseFloat(unitCost) || 0;
  const lineAmount = decimalProduct(qtyNum, unitCostNum);

  return (
    <div className="card">
      <h1>Add items</h1>
      {storageError && <div className="alert alert-warning" role="status">Draft could not be saved. Keep this tab open until you add the item.</div>}
      {(staleSection || staleCategory || staleBudget) && <div className="alert alert-warning" role="status">A saved selection is no longer available. Check the section, category and budget.</div>}
      <ErrorMessage error={(currentMutation && createMutation.error) || formError} />
      {currentMutation && createMutation.isSuccess && <p className="request-confirmation" role="status">{createMutation.data.name} added to inventory.</p>}
      {isAdmin && !getEffectiveProjectSite() && <div className="alert alert-warning">Select a project site in the header before adding an item.</div>}

      {!isAdmin && (
        <div className="alert alert-warning">
          Read-only mode. You do not have permission to add items.
        </div>
      )}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="manualentry-field-1">Building type</label>
          <select id="manualentry-field-1" disabled={createMutation.isPending} value={buildingType} onChange={(e) => updateDraft({ buildingType: e.target.value, budgetLabel: '' })}>
            {PROPERTY_TYPES.map((t) => (
              <option key={t || 'all'} value={t}>
                {t || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="manualentry-field-2">Budget number</label>
          <select id="manualentry-field-2" disabled={createMutation.isPending} value={budgetNum} onChange={(e) => updateDraft({ budgetNum: e.target.value, budgetLabel: '' })}>
            <option value="">All</option>
            {Array.from({ length: 20 }, (_, i) => (
              <option key={i} value={`Budget ${i + 1}`}>
                Budget {i + 1}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="manualentry-field-3">Section</label>
          <select id="manualentry-field-3" disabled={createMutation.isPending} value={section} onChange={(e) => updateDraft({ section: e.target.value })}>
            <option value="">All</option>
            {staleSection && <option value={section} disabled>{section} — unavailable</option>}
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="manualentry-field-4">Budget</label>
          <select id="manualentry-field-4" disabled={createMutation.isPending} value={budgetLabel} onChange={(e) => updateDraft({ budgetLabel: e.target.value })}>
            <option value="">All</option>
            {staleBudget && <option value={budgetLabel} disabled>{budgetLabel} — unavailable</option>}
            {budgetLabels.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isAdmin && (
        <form onSubmit={handleSubmit} className="add-item-form">
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label htmlFor="manualentry-field-5">Item name</label>
              <input id="manualentry-field-5"
                value={name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                placeholder="Item name"
                maxLength={255}
                disabled={createMutation.isPending}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-6">Quantity</label>
              <input id="manualentry-field-6"
                type="number"
                required
                disabled={createMutation.isPending}
                min={0}
                step="any"
                value={qty}
                onChange={(e) => updateDraft({ qty: e.target.value })}
                placeholder="0"
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-7">Unit</label>
              <input id="manualentry-field-7"
                value={unit}
                onChange={(e) => updateDraft({ unit: e.target.value })}
                placeholder="pcs, trips, bags"
                required
                maxLength={50}
                disabled={createMutation.isPending}
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-8">Unit cost (₦)</label>
              <input id="manualentry-field-8"
                type="number"
                required
                disabled={createMutation.isPending}
                min={0}
                step={0.01}
                value={unitCost}
                onChange={(e) => updateDraft({ unitCost: e.target.value })}
                placeholder="0"
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-9">Category</label>
              <select id="manualentry-field-9" disabled={createMutation.isPending} value={category} onChange={(e) => updateDraft({ category: e.target.value })}>
                {staleCategory && <option value={category} disabled>{category} — unavailable</option>}
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="line-amount">Line amount: {formatNaira(lineAmount)}</p>
          <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Adding…' : 'Add item'}
          </button>
          {draftChanged(draft, MANUAL_ENTRY_DRAFT) && <button type="button" className="btn" disabled={createMutation.isPending} onClick={() => { clearDraft(); setFormError(''); createMutation.reset(); }}>Discard draft</button>}
        </form>
      )}
    </div>
  );
}
