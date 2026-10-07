import { formatQuantity, requestAvailability } from '../utils/inventory.js';

export default function AvailabilityNotice({ quantity, available, unit = 'units' }) {
  const state = requestAvailability(quantity, available);
  if (!state.valid || !state.known) return null;
  return <section className={`availability-notice${state.insufficient ? ' availability-shortage' : ''}`} role={state.insufficient ? 'alert' : 'status'}>
    <h3>{state.insufficient ? 'Insufficient quantity' : 'Quantity available'}</h3>
    <div className="availability-figures">
      <div><span>Available now</span><strong>{formatQuantity(state.remaining)} <small>{unit}</small></strong></div>
      <div><span>Requested</span><strong>{formatQuantity(state.requested)} <small>{unit}</small></strong></div>
      {state.insufficient && <div><span>Shortfall</span><strong>{formatQuantity(state.shortage)} <small>{unit}</small></strong></div>}
    </div>
  </section>;
}
