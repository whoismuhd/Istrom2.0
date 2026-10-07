import ErrorMessage from './ErrorMessage';

export default function LoadError({ error, onRetry }) {
  return (
    <div className="card">
      <p>Could not load this page.</p>
      <ErrorMessage error={error} />
      <button className="btn btn-secondary" onClick={onRetry}>Retry</button>
    </div>
  );
}
